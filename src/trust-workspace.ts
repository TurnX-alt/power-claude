// trust-workspace.ts — 信任所有工作区：直写 ~/.claude.json projects 字段
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { homedir, platform } from 'node:os';
import { join } from 'node:path';
import { execSync } from 'node:child_process';

// ── 路径 ──

function getClaudeJsonPath(): string {
  return join(homedir(), '.claude.json');
}

function getBackupPath(): string {
  const ts = new Date().toISOString().replace(/[:T]/g, '-').slice(0, 19);
  return join(homedir(), `.claude.json.bak-${ts}`);
}

// ── 类型 ──

interface ClaudeJson {
  projects?: Record<string, { hasTrustDialogAccepted?: boolean; [key: string]: unknown }>;
  [key: string]: unknown;
}

export interface TrustResult {
  /** 备份路径（无操作时为 null） */
  backupPath: string | null;
  /** home 信任是否为本轮新写入 */
  homeTrusted: boolean;
  /** 翻转 false→true 的已有条目数 */
  flippedCount: number;
  /** 进程警告（若 claude 在运行），用于向导汇总 */
  warning: string | null;
}

// ── 读取 ──

function readClaudeJson(): ClaudeJson {
  const path = getClaudeJsonPath();
  if (!existsSync(path)) return {};
  try {
    return JSON.parse(readFileSync(path, 'utf-8')) as ClaudeJson;
  } catch {
    return {};
  }
}

// ── 写入 ──

function writeClaudeJson(data: ClaudeJson): void {
  if (!existsSync(homedir())) mkdirSync(homedir(), { recursive: true });
  writeFileSync(getClaudeJsonPath(), JSON.stringify(data, null, 2), 'utf-8');
}

// ── 备份 ──

function backupClaudeJson(): string {
  const src = getClaudeJsonPath();
  if (!existsSync(src)) {
    // 文件尚不存在 → 创空占位，备份即该空占位的副本
    writeFileSync(src, '{}', 'utf-8');
  }
  const dest = getBackupPath();
  writeFileSync(dest, readFileSync(src));
  return dest;
}

// ── 进程检测 ──

/** 检查 claude 进程是否存活（Windows: tasklist；macOS/Linux: ps） */
export function isClaudeProcessRunning(): boolean {
  try {
    if (platform() === 'win32') {
      const out = execSync('tasklist /FI "IMAGENAME eq claude.exe" /FO CSV /NH', {
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'ignore'],
        timeout: 10_000,
      });
      return out.toLowerCase().includes('claude.exe');
    }
    const out = execSync('ps -ax -o comm= | grep -E "(^|/)claude$" | grep -v grep', {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
      timeout: 10_000,
    });
    return out.trim().length > 0;
  } catch {
    return false;
  }
}

// ── 信任所有工作区 ──

/**
 * 信任所有工作区：备份 → 设 home 为信任根 → 翻已有 false 条目为 true。
 * 返回 null 表示全部已就绪（幂等：home 已是 true 且无 false 条目）。
 */
export function trustAllWorkspaces(): TrustResult | null {
  const data = readClaudeJson();
  const projects = data.projects ?? {};
  data.projects = projects;

  const homePath = homedir().replace(/\\/g, '/');

  // 检查当前状态
  const homeEntry = projects[homePath];
  const homeAlreadyTrusted = homeEntry?.hasTrustDialogAccepted === true;
  const falseKeys = Object.keys(projects).filter(
    k => projects[k].hasTrustDialogAccepted === false,
  );

  // 幂等：无需操作
  if (homeAlreadyTrusted && falseKeys.length === 0) return null;

  // 需要写入：先备份
  const backupPath = backupClaudeJson();

  // 再次读取（备份已刷新文件） → 写入目标值
  const current = readClaudeJson();
  if (!current.projects) current.projects = {};
  const proj = current.projects!;

  // 设 home 为信任根（合并已有字段）
  const home = proj[homePath] ?? ({} as Record<string, unknown>);
  home.hasTrustDialogAccepted = true;
  proj[homePath] = home;

  // 翻转 false → true
  let flippedCount = 0;
  for (const k of Object.keys(proj)) {
    if (proj[k].hasTrustDialogAccepted === false) {
      proj[k].hasTrustDialogAccepted = true;
      flippedCount++;
    }
  }

  writeClaudeJson(current);

  // 进程检测（仅警告，不杀进程）
  const warning = isClaudeProcessRunning()
    ? '⚠️ 检测到运行中的 claude 进程，重启后可能覆盖信任配置——若复现请关闭所有会话后重跑本步骤'
    : null;

  return {
    backupPath,
    homeTrusted: !homeAlreadyTrusted,
    flippedCount,
    warning,
  };
}