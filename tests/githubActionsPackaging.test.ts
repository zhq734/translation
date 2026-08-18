import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'
import test from 'node:test'

const workflowPath = '.github/workflows/package.yml'

/**
 * 读取多平台打包工作流内容。
 * @returns GitHub Actions 工作流的 UTF-8 文本。
 * @author zhenghq
 */
function readPackagingWorkflow(): string {
  assert.equal(existsSync(workflowPath), true, `缺少 GitHub Actions 工作流：${workflowPath}`)
  return readFileSync(workflowPath, 'utf8')
}

/**
 * 校验工作流支持手动打包，并在推送版本标签时自动执行发布流程。
 * @returns 无返回值。
 * @author zhenghq
 */
test('GitHub Actions 应支持手动触发与版本标签触发', () => {
  const workflow = readPackagingWorkflow()

  assert.match(workflow, /workflow_dispatch:/u)
  assert.match(workflow, /push:\s*\n\s+tags:/u)
  assert.match(workflow, /['"]v\*['"]/u)
  assert.match(workflow, /['"]V\*['"]/u)
})

/**
 * 校验工作流在各自的原生运行器上构建 macOS、Windows 与 Linux 安装包。
 * @returns 无返回值。
 * @author zhenghq
 */
test('GitHub Actions 应覆盖 macOS、Windows 与 Linux 打包任务', () => {
  const workflow = readPackagingWorkflow()

  assert.match(workflow, /os:\s*macos-[\w-]+/u)
  assert.match(workflow, /command:\s*dist:mac:ci/u)
  assert.match(workflow, /os:\s*windows-[\w-]+/u)
  assert.match(workflow, /command:\s*dist:win/u)
  assert.match(workflow, /os:\s*ubuntu-[\d.]+/u)
  assert.match(workflow, /command:\s*dist:linux/u)
  assert.match(workflow, /npm ci/u)
  assert.match(workflow, /npm test/u)
  assert.match(workflow, /npm run typecheck/u)
  assert.match(workflow, /npm run \$\{\{ matrix\.command \}\}/u)
})

/**
 * 校验 macOS 流水线必须使用 Developer ID 签名并提交 Apple 公证，避免下载后被 Gatekeeper 判定为损坏。
 * @returns 无返回值。
 * @author zhenghq
 */
test('GitHub Actions 的 macOS 安装包应完成签名、公证与 Gatekeeper 验证', () => {
  const workflow = readPackagingWorkflow()

  assert.match(workflow, /secrets\.MACOS_CERTIFICATE_BASE64/u)
  assert.match(workflow, /secrets\.MACOS_CERTIFICATE_PASSWORD/u)
  assert.match(workflow, /secrets\.APPLE_API_KEY_P8/u)
  assert.match(workflow, /secrets\.APPLE_API_KEY_ID/u)
  assert.match(workflow, /secrets\.APPLE_API_ISSUER/u)
  assert.match(workflow, /CSC_LINK:\s*\$\{\{ secrets\.MACOS_CERTIFICATE_BASE64 \}\}/u)
  assert.match(workflow, /APPLE_API_KEY:\s*\$\{\{ runner\.temp \}\}\/AuthKey_\$\{\{ secrets\.APPLE_API_KEY_ID \}\}\.p8/u)
  assert.match(workflow, /shopt -s nullglob/u)
  assert.match(workflow, /codesign --verify --deep --strict/u)
  assert.match(workflow, /Authority=Developer ID Application:/u)
  assert.match(workflow, /xcrun stapler validate/u)
  assert.match(workflow, /spctl --assess --type execute/u)
  assert.doesNotMatch(workflow, /CSC_IDENTITY_AUTO_DISCOVERY:\s*['"]false['"]/u)
})

/**
 * 校验各平台安装包会作为工作流产物上传，缺少产物时立即失败。
 * @returns 无返回值。
 * @author zhenghq
 */
test('GitHub Actions 应上传各平台安装包产物', () => {
  const workflow = readPackagingWorkflow()

  assert.match(workflow, /actions\/upload-artifact@v7/u)
  assert.match(workflow, /dist\/SelectionTranslator-\*-mac-\*\.dmg/u)
  assert.match(workflow, /dist\/SelectionTranslator-\*-mac-\*\.zip/u)
  assert.match(workflow, /dist\/SelectionTranslator-\*-Setup-\*\.exe/u)
  assert.match(workflow, /dist\/SelectionTranslator-\*-linux-\*\.AppImage/u)
  assert.match(workflow, /dist\/latest\*\.yml/u)
  assert.match(workflow, /dist\/\*\.blockmap/u)
  assert.match(workflow, /if-no-files-found:\s*error/u)
})

/**
 * 校验版本标签触发时会合并安装包、生成校验和并上传 GitHub Release。
 * @returns 无返回值。
 * @author zhenghq
 */
test('GitHub Actions 应在标签构建后发布 Release 与 SHA256SUMS', () => {
  const workflow = readPackagingWorkflow()

  assert.match(workflow, /startsWith\(github\.ref, 'refs\/tags\/'\)/u)
  assert.match(workflow, /VERSION="\$\{VERSION#v\}"/u)
  assert.match(workflow, /VERSION="\$\{VERSION#V\}"/u)
  assert.match(workflow, /npm version "\$VERSION" --no-git-tag-version --allow-same-version/u)
  assert.match(workflow, /contents:\s*write/u)
  assert.match(workflow, /actions\/download-artifact@v8/u)
  assert.match(workflow, /merge-multiple:\s*true/u)
  assert.match(workflow, /scripts\/generate-checksums\.mjs/u)
  assert.match(workflow, /gh release create/u)
  assert.match(workflow, /gh release upload/u)
})

/**
 * 校验新 Release 在全部安装包和更新清单上传完成后才公开，避免客户端读取到不完整资产。
 * @returns 无返回值。
 * @author zhenghq
 */
test('GitHub Actions 应先使用草稿 Release 上传全部资产再正式发布', () => {
  const workflow = readPackagingWorkflow()
  const createIndex = workflow.indexOf('gh release create "$GITHUB_REF_NAME"')
  const uploadIndex = workflow.indexOf('gh release upload "$GITHUB_REF_NAME"')
  const publishIndex = workflow.indexOf('gh release edit "$GITHUB_REF_NAME" --draft=false')

  assert.ok(createIndex >= 0)
  assert.match(workflow.slice(createIndex, uploadIndex), /--draft/u)
  assert.ok(uploadIndex > createIndex)
  assert.ok(publishIndex > uploadIndex)
})

/**
 * 校验 electron-builder 使用公开 GitHub Release 作为更新源。
 * @returns 无返回值。
 * @author zhenghq
 */
test('打包配置应生成 GitHub 自动更新元数据', () => {
  const packageJson = JSON.parse(readFileSync('package.json', 'utf8')) as {
    scripts?: Record<string, string>
    dependencies?: Record<string, string>
    build?: {
      publish?: Array<Record<string, string>>
      mac?: {
        identity?: string | null
        hardenedRuntime?: boolean
        notarize?: boolean
      }
    }
  }

  assert.ok(packageJson.dependencies?.['electron-updater'])
  assert.deepEqual(packageJson.build?.publish, [
    {
      provider: 'github',
      owner: 'zhq734',
      repo: 'translation'
    }
  ])
  assert.equal(
    packageJson.scripts?.['dist:mac:ci'],
    'npm run build && electron-builder --mac --x64 --arm64 --publish never --config.forceCodeSigning=true'
  )
  assert.notEqual(packageJson.build?.mac?.identity, null)
  assert.equal(packageJson.build?.mac?.hardenedRuntime, true)
  assert.equal(packageJson.build?.mac?.notarize, true)
})
