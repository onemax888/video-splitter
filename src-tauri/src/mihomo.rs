use chrono::Local;
use reqwest::StatusCode;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::collections::HashSet;
use std::net::TcpListener;
use std::path::{Path, PathBuf};
use std::sync::Arc;
use tauri::AppHandle;
use tauri_plugin_shell::process::CommandChild;
use tauri_plugin_shell::ShellExt;
use tokio::sync::Semaphore;
use tokio::time::{sleep, Duration};

const PROXY_DELAY_CONCURRENCY: usize = 32;
const PROXY_DELAY_TIMEOUT_MS: u64 = 2500;
const PROXY_DELAY_REQUEST_TIMEOUT_MS: u64 = PROXY_DELAY_TIMEOUT_MS + 1000;

#[derive(Debug, Serialize, Deserialize, Clone, Default)]
#[serde(rename_all = "camelCase")]
pub struct ProxyOptions {
    pub enabled: bool,
    pub config_path: Option<String>,
    pub node_name: Option<String>,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct ProxyConfigInfo {
    pub config_path: String,
    pub nodes: Vec<String>,
    pub default_node: Option<String>,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct ProxyNodeDelay {
    pub name: String,
    pub delay_ms: Option<u64>,
    pub error: Option<String>,
}

pub struct MihomoSession {
    child: Option<CommandChild>,
    proxy_url: String,
    controller_port: u16,
}

impl MihomoSession {
    pub fn proxy_url(&self) -> &str {
        &self.proxy_url
    }

    fn controller_port(&self) -> u16 {
        self.controller_port
    }
}

impl Drop for MihomoSession {
    fn drop(&mut self) {
        if let Some(child) = self.child.take() {
            let _ = child.kill();
        }
    }
}

pub async fn import_proxy_config_from_url(url: &str) -> Result<ProxyConfigInfo, String> {
    let trimmed = url.trim();
    if trimmed.is_empty() {
        return Err("请输入代理配置链接".to_string());
    }

    let body = reqwest::Client::new()
        .get(trimmed)
        .send()
        .await
        .map_err(|e| format!("下载代理配置失败: {}", e))?
        .text()
        .await
        .map_err(|e| format!("读取代理配置失败: {}", e))?;

    if body.trim().is_empty() {
        return Err("代理配置内容为空".to_string());
    }

    let path = proxy_config_store_dir()?.join("imported-proxy.yaml");
    tokio::fs::write(&path, body)
        .await
        .map_err(|e| format!("保存代理配置失败: {}", e))?;
    inspect_proxy_config(path)
}

pub async fn import_proxy_config_from_file(path: &str) -> Result<ProxyConfigInfo, String> {
    let source = Path::new(path);
    if !source.exists() {
        return Err("代理配置文件不存在".to_string());
    }
    let content = tokio::fs::read_to_string(source)
        .await
        .map_err(|e| format!("读取代理配置文件失败: {}", e))?;
    if content.trim().is_empty() {
        return Err("代理配置内容为空".to_string());
    }

    let target = proxy_config_store_dir()?.join("imported-proxy.yaml");
    tokio::fs::write(&target, content)
        .await
        .map_err(|e| format!("保存代理配置失败: {}", e))?;
    inspect_proxy_config(target)
}

pub fn inspect_proxy_config(path: PathBuf) -> Result<ProxyConfigInfo, String> {
    let content = std::fs::read_to_string(&path).map_err(|e| format!("读取代理配置失败: {}", e))?;
    let nodes = parse_proxy_nodes(&content);
    let default_node = choose_default_node(&nodes);
    Ok(ProxyConfigInfo {
        config_path: path.to_string_lossy().to_string(),
        nodes,
        default_node,
    })
}

pub async fn start_mihomo_proxy(
    app_handle: &AppHandle,
    options: &ProxyOptions,
) -> Result<MihomoSession, String> {
    if !options.enabled {
        return Err("代理未启用".to_string());
    }

    let config_path = options
        .config_path
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .ok_or_else(|| "请先导入代理配置".to_string())?;
    let content = tokio::fs::read_to_string(config_path)
        .await
        .map_err(|e| format!("读取代理配置失败: {}", e))?;
    let nodes = parse_proxy_nodes(&content);
    let selected_node = options
        .node_name
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(ToString::to_string)
        .or_else(|| choose_default_node(&nodes));

    let mixed_port = free_port()?;
    let controller_port = free_port()?;
    let work_dir = std::env::temp_dir().join(format!(
        "video-clipping-mihomo-{}",
        Local::now().format("%Y%m%d%H%M%S%3f")
    ));
    tokio::fs::create_dir_all(&work_dir)
        .await
        .map_err(|e| format!("创建 mihomo 临时目录失败: {}", e))?;

    let runtime_config = rewrite_mihomo_config(&content, mixed_port, controller_port);
    let runtime_config_path = work_dir.join("config.yaml");
    tokio::fs::write(&runtime_config_path, runtime_config)
        .await
        .map_err(|e| format!("写入 mihomo 临时配置失败: {}", e))?;

    let (_rx, child) = app_handle
        .shell()
        .sidecar("mihomo")
        .map_err(|e| format!("mihomo sidecar 不可用: {}", e))?
        .args([
            "-d",
            work_dir.to_string_lossy().as_ref(),
            "-f",
            runtime_config_path.to_string_lossy().as_ref(),
        ])
        .spawn()
        .map_err(|e| format!("启动 mihomo 失败: {}", e))?;

    wait_for_controller(controller_port).await?;

    if let Some(node) = selected_node {
        select_mihomo_node(controller_port, &node).await?;
    }

    Ok(MihomoSession {
        child: Some(child),
        proxy_url: format!("http://127.0.0.1:{mixed_port}"),
        controller_port,
    })
}

pub async fn measure_proxy_node_delays(
    app_handle: &AppHandle,
    config_path: &str,
) -> Result<Vec<ProxyNodeDelay>, String> {
    let content = tokio::fs::read_to_string(config_path)
        .await
        .map_err(|e| format!("读取代理配置失败: {}", e))?;
    let nodes = parse_proxy_nodes(&content);
    if nodes.is_empty() {
        return Err("代理配置中未找到可测速节点".to_string());
    }

    let options = ProxyOptions {
        enabled: true,
        config_path: Some(config_path.to_string()),
        node_name: None,
    };
    let session = start_mihomo_proxy(app_handle, &options).await?;
    let controller_port = session.controller_port();
    let client = reqwest::Client::builder()
        .timeout(Duration::from_millis(PROXY_DELAY_REQUEST_TIMEOUT_MS))
        .build()
        .map_err(|e| format!("创建测速客户端失败: {}", e))?;
    let semaphore = Arc::new(Semaphore::new(PROXY_DELAY_CONCURRENCY));
    let mut tasks = tokio::task::JoinSet::new();

    for (index, name) in nodes.iter().cloned().enumerate() {
        let client = client.clone();
        let semaphore = Arc::clone(&semaphore);
        tasks.spawn(async move {
            let _permit = semaphore
                .acquire_owned()
                .await
                .map_err(|e| format!("测速队列异常: {}", e))?;
            let delay = measure_single_node_delay(&client, controller_port, &name).await;
            Ok::<_, String>((index, delay))
        });
    }

    let mut results: Vec<Option<ProxyNodeDelay>> = vec![None; nodes.len()];
    while let Some(result) = tasks.join_next().await {
        match result {
            Ok(Ok((index, delay))) => {
                results[index] = Some(delay);
            }
            Ok(Err(e)) => {
                return Err(e);
            }
            Err(e) => {
                return Err(format!("节点测速任务失败: {}", e));
            }
        }
    }

    Ok(results.into_iter().flatten().collect())
}

async fn measure_single_node_delay(
    client: &reqwest::Client,
    controller_port: u16,
    node: &str,
) -> ProxyNodeDelay {
    let url = format!(
        "http://127.0.0.1:{}/proxies/{}/delay?timeout={}&url={}",
        controller_port,
        url_encode(node),
        PROXY_DELAY_TIMEOUT_MS,
        url_encode("http://www.gstatic.com/generate_204")
    );

    match client.get(url).send().await {
        Ok(response) if response.status().is_success() => match response.json::<Value>().await {
            Ok(value) => ProxyNodeDelay {
                name: node.to_string(),
                delay_ms: value.get("delay").and_then(Value::as_u64),
                error: None,
            },
            Err(e) => ProxyNodeDelay {
                name: node.to_string(),
                delay_ms: None,
                error: Some(format!("解析失败: {}", e)),
            },
        },
        Ok(response) => ProxyNodeDelay {
            name: node.to_string(),
            delay_ms: None,
            error: Some(format!("HTTP {}", response.status())),
        },
        Err(e) => ProxyNodeDelay {
            name: node.to_string(),
            delay_ms: None,
            error: Some(e.to_string()),
        },
    }
}

fn proxy_config_store_dir() -> Result<PathBuf, String> {
    let home = std::env::var("HOME").map_err(|_| "无法定位 HOME 目录".to_string())?;
    let dir = Path::new(&home)
        .join(".video-clipping")
        .join("proxy-configs");
    std::fs::create_dir_all(&dir).map_err(|e| format!("创建代理配置目录失败: {}", e))?;
    Ok(dir)
}

fn free_port() -> Result<u16, String> {
    TcpListener::bind("127.0.0.1:0")
        .map_err(|e| format!("分配本地端口失败: {}", e))?
        .local_addr()
        .map(|addr| addr.port())
        .map_err(|e| format!("读取本地端口失败: {}", e))
}

fn rewrite_mihomo_config(content: &str, mixed_port: u16, controller_port: u16) -> String {
    let mut lines = Vec::new();
    let mut skipped_keys = HashSet::from([
        "port",
        "socks-port",
        "mixed-port",
        "redir-port",
        "tproxy-port",
        "allow-lan",
        "bind-address",
        "external-controller",
        "secret",
    ]);

    for line in content.lines() {
        let trimmed = line.trim_start();
        if !line.starts_with(' ') && !line.starts_with('\t') {
            if let Some((key, _)) = trimmed.split_once(':') {
                if skipped_keys.remove(key.trim())
                    || matches!(
                        key.trim(),
                        "port"
                            | "socks-port"
                            | "mixed-port"
                            | "redir-port"
                            | "tproxy-port"
                            | "allow-lan"
                            | "bind-address"
                            | "external-controller"
                            | "secret"
                    )
                {
                    continue;
                }
            }
        }
        lines.push(line.to_string());
    }

    lines.insert(
        0,
        format!("external-controller: 127.0.0.1:{controller_port}"),
    );
    lines.insert(0, "secret: \"\"".to_string());
    lines.insert(0, "bind-address: 127.0.0.1".to_string());
    lines.insert(0, "allow-lan: false".to_string());
    lines.insert(0, format!("mixed-port: {mixed_port}"));
    lines.join("\n")
}

fn parse_proxy_nodes(content: &str) -> Vec<String> {
    let mut nodes = Vec::new();
    let mut in_proxies = false;

    for line in content.lines() {
        let trimmed = line.trim();
        if trimmed == "proxies:" {
            in_proxies = true;
            continue;
        }
        if in_proxies && !line.starts_with(' ') && !line.starts_with('-') && trimmed.ends_with(':')
        {
            break;
        }
        if !in_proxies {
            continue;
        }
        if let Some(name) = parse_yaml_name(trimmed) {
            if !nodes.iter().any(|item| item == &name) {
                nodes.push(name);
            }
        }
    }

    nodes
}

fn parse_yaml_name(trimmed: &str) -> Option<String> {
    if let Some(name) = parse_block_yaml_name(trimmed) {
        return Some(name);
    }
    parse_inline_yaml_name(trimmed)
}

fn parse_block_yaml_name(trimmed: &str) -> Option<String> {
    let raw = trimmed
        .strip_prefix("- name:")
        .or_else(|| trimmed.strip_prefix("name:"))?
        .trim();
    clean_yaml_value(raw)
}

fn parse_inline_yaml_name(trimmed: &str) -> Option<String> {
    let inline = trimmed.strip_prefix('-')?.trim();
    if !inline.starts_with('{') {
        return None;
    }

    let (_, raw_value) = inline.split_once("name:")?;
    let raw_value = raw_value.trim();
    let value = if let Some(rest) = raw_value.strip_prefix('\'') {
        rest.split_once('\'').map(|(value, _)| value)?
    } else if let Some(rest) = raw_value.strip_prefix('"') {
        rest.split_once('"').map(|(value, _)| value)?
    } else {
        raw_value
            .split_once(',')
            .map(|(value, _)| value)
            .unwrap_or(raw_value)
    };
    clean_yaml_value(value)
}

fn clean_yaml_value(value: &str) -> Option<String> {
    Some(
        value
            .trim()
            .trim_end_matches('}')
            .trim()
            .trim_matches('"')
            .trim_matches('\'')
            .trim()
            .to_string(),
    )
    .filter(|value| !value.is_empty())
}

fn choose_default_node(nodes: &[String]) -> Option<String> {
    let hk_keywords = ["香港", "港", "hk", "hong kong", "hongkong"];
    nodes
        .iter()
        .filter(|node| !is_proxy_info_node(node))
        .find(|node| {
            let lower = node.to_lowercase();
            hk_keywords.iter().any(|keyword| lower.contains(keyword))
        })
        .cloned()
        .or_else(|| nodes.iter().find(|node| !is_proxy_info_node(node)).cloned())
        .or_else(|| nodes.first().cloned())
}

fn is_proxy_info_node(node: &str) -> bool {
    ["剩余流量", "距离下次", "套餐到期", "超时"]
        .iter()
        .any(|keyword| node.contains(keyword))
}

async fn wait_for_controller(port: u16) -> Result<(), String> {
    let client = reqwest::Client::new();
    let url = format!("http://127.0.0.1:{port}/version");
    for _ in 0..80 {
        if let Ok(response) = client.get(&url).send().await {
            if response.status().is_success() {
                return Ok(());
            }
        }
        sleep(Duration::from_millis(250)).await;
    }
    Err("mihomo 控制端口启动超时".to_string())
}

async fn select_mihomo_node(port: u16, node: &str) -> Result<(), String> {
    let client = reqwest::Client::new();
    let proxies_url = format!("http://127.0.0.1:{port}/proxies");
    let proxies: Value = client
        .get(&proxies_url)
        .send()
        .await
        .map_err(|e| format!("读取 mihomo 节点失败: {}", e))?
        .json()
        .await
        .map_err(|e| format!("解析 mihomo 节点失败: {}", e))?;

    let Some(map) = proxies.get("proxies").and_then(Value::as_object) else {
        return Ok(());
    };

    for (group_name, value) in map {
        let all = value.get("all").and_then(Value::as_array);
        let contains_node = all
            .map(|items| items.iter().any(|item| item.as_str() == Some(node)))
            .unwrap_or(false);
        if !contains_node {
            continue;
        }

        let url = format!("http://127.0.0.1:{port}/proxies/{}", url_encode(group_name));
        let response = client
            .put(url)
            .json(&serde_json::json!({ "name": node }))
            .send()
            .await
            .map_err(|e| format!("切换 mihomo 节点失败: {}", e))?;
        if !matches!(response.status(), StatusCode::NO_CONTENT | StatusCode::OK) {
            continue;
        }
    }

    Ok(())
}

fn url_encode(value: &str) -> String {
    value
        .bytes()
        .flat_map(|byte| match byte {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'_' | b'.' | b'~' => {
                vec![byte as char]
            }
            _ => format!("%{byte:02X}").chars().collect(),
        })
        .collect()
}
