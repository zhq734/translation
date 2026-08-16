import { app } from 'electron'
import { existsSync, readFileSync, writeFileSync, mkdirSync, renameSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { DEFAULT_SETTINGS, normalizeSettings } from '../shared/settingsDefaults'
import type { Settings } from '../shared/types'

let cache: Settings = { ...DEFAULT_SETTINGS }

/**
 * 返回设置文件路径。
 * @returns 当前用户的设置文件路径。
 * @author zhenghq
 */
function filePath(): string {
  return join(app.getPath('userData'), 'settings.json')
}

/**
 * 将候选设置原子写入磁盘，失败时抛出异常且不修改内存设置。
 * @param settings 待持久化的完整设置。
 * @returns 无返回值。
 * @author zhenghq
 */
function persistSettings(settings: Settings): void {
  const path = filePath()
  const temporaryPath = `${path}.tmp`
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(temporaryPath, JSON.stringify(settings, null, 2))
  renameSync(temporaryPath, path)
  console.log(`[settings] 已保存到 ${path}`)
}

/**
 * 获取当前内存中的完整设置。
 * @returns 当前设置。
 * @author zhenghq
 */
export function getSettings(): Settings {
  return cache
}

/**
 * 从磁盘加载并升级设置，旧版配置会切换到新的默认划词交互。
 * @returns 加载后的完整设置。
 * @author zhenghq
 */
export function loadSettings(): Settings {
  try {
    const path = filePath()
    if (existsSync(path)) {
      const raw = JSON.parse(readFileSync(path, 'utf-8')) as Partial<Settings>
      cache = normalizeSettings(raw)
      if (raw.schemaVersion !== cache.schemaVersion) {
        try {
          persistSettings(cache)
        } catch (error) {
          console.error('[settings] 迁移后的配置保存失败:', (error as Error).message)
        }
      }
    } else {
      cache = { ...DEFAULT_SETTINGS }
    }
  } catch (error) {
    console.error('[settings] 读取配置失败，使用默认值:', (error as Error).message)
    cache = { ...DEFAULT_SETTINGS }
  }
  return cache
}

/**
 * 合并设置补丁并原子持久化，写入失败时保留上一份内存设置。
 * @param patch 需要更新的设置字段。
 * @returns 保存后的完整设置。
 * @author zhenghq
 */
export function saveSettings(patch: Partial<Settings>): Settings {
  const candidate = normalizeSettings({ ...cache, ...patch })
  persistSettings(candidate)
  cache = candidate
  return cache
}
