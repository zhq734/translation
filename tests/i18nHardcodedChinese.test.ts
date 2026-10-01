import assert from 'node:assert/strict'
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { createRequire } from 'node:module'
import { join } from 'node:path'
import test from 'node:test'

// TypeScript 以 CommonJS 发布，在 ESM 测试产物中需从项目根目录解析，避免动态 require 失败。
const require = createRequire(process.cwd() + '/')
const ts = require('typescript') as typeof import('typescript')

/** 需要扫描硬编码中文的源码根目录。 */
const SOURCE_ROOTS = ['src/main', 'src/renderer/src', 'src/shared'] as const

/** 不参与用户可见文案扫描的目录前缀。 */
const EXCLUDED_DIRECTORIES = ['src/shared/i18n/'] as const

/** 允许保留硬编码中文的日志调用名模式。 */
const LOG_CALL_PATTERN = /(?:^|\.)(?:log|warn|error|info|debug)[A-Za-z]*$|^log[A-Z][A-Za-z]*$/

/** 匹配中日韩表意文字，用于定位潜在的未本地化文案。 */
const CJK_PATTERN = /[\u3400-\u4dbf\u4e00-\u9fff]/u

/**
 * 单个被扫描到的硬编码中文字符串字面量。
 * @author zhenghq
 */
interface HardcodedChineseFinding {
  /** 相对仓库根目录的源文件路径。 */
  file: string
  /** 1 基行号。 */
  line: number
  /** 命中的字符串文本。 */
  text: string
}

/**
 * 允许保留硬编码中文的显式白名单，逐项说明为什么不是用户可见文案。
 * key 为相对仓库根目录的源文件路径，value 为允许保留的字符串文本集合。
 * @author zhenghq
 */
const ALLOWED_HARDCODED_CHINESE: Readonly<Record<string, readonly string[]>> = {
  'src/main/aiProtocol.ts': [
    // AI 翻译系统提示词固定发送给模型，不展示给最终用户。
    '你是一个专业翻译引擎，请将用户输入的文本从',
    '翻译为',
    '，只输出译文，保留换行和基本格式，不要输出解释、思考过程、工具调用、Markdown 代码块或额外引号。',
    '若原文包含形如 [[[ST-SEG-数字]]] 的分段标记，必须原样保留这些标记，不得翻译、改写、增删或调整其顺序。',
    // 不可达的内部协议兜底错误，调用方已包装为本地化错误。
    '不支持的 AI 协议：'
  ],
  // 安装到“应用程序”目录后的固定真实路径，必须与打包后的应用名一致。
  'src/main/macQuarantine.ts': ['/Applications/划词翻译.app'],
  // 仅用于内部校验结果的占位安装包名，不会直接展示给用户。
  'src/main/releaseChecksums.ts': ['未知安装包'],
  'src/renderer/src/speech.ts': [
    // 系统语音名称的质量关键词匹配，用于挑选更自然的语音，不展示给用户。
    '自然',
    '神经',
    '高级',
    '增强'
  ],
  'src/shared/buildMetadata.ts': [
    // 构建元数据校验的内部错误，仅用于开发与打包诊断。
    '构建元数据字段 ',
    ' 不能为空',
    '构建元数据字段 version 必须是规范化 SemVer：'
  ],
  // OCR 乱码判定使用的常用汉字频表，不展示给用户。
  'src/shared/ocrScoring.ts': [
    '的一是在不了有和人这中大为上个国我以要他时来用们生到作地于出就分对成会可主发年动同工也能下过子说产种面而方后多定行学法所民得经十三之进着等部度家电力里如水化高自二理起小物现实加量都两体制机当使点从业本去把性好应开它合还因由其些然前外天政四日那社义事平形相全表间样与关各重新线内数正心反你明看原又么利比或但质气第向道命此变条只没结解问意建月公无系军很情者最立代想已通并提直题党程展五果料象员革位入常文总次品式活设及管特件长求老头基资边流路级少图山统接知较将组见计别她手角期根论运农指几九区强放决西被干做必战先回则任取据处队南给色光门即保治北造百规热领七海口东导器压志世金增争济阶油思术极交受联什认六共权收证改清己美再采转更单风切打白教速花带安场身车例真务具万每目至达走积示议声报斗完类八离华名确才科张信马节话米整空元况今集温传土许步群广石记需段研界拉林律叫且究观越织装影算低持音众书布复容儿须际商非验连断深难近矿千周委素技备半办青省列习响约支般史感劳便团往酸历市克何除消构府称太准精值号率族维划选标写存候毛亲快效斯院查江型眼王按格养易置派层片始却专状育厂京识适属圆包火住调满县局照参红细引听该铁价严龙飞'
  ]
}

/**
 * 递归收集指定目录下的源码文件。
 * @param directory 待扫描目录。
 * @returns 源码文件的相对路径列表。
 * @author zhenghq
 */
function collectSourceFiles(directory: string): string[] {
  const files: string[] = []
  for (const entry of readdirSync(directory)) {
    const fullPath = join(directory, entry)
    if (statSync(fullPath).isDirectory()) {
      files.push(...collectSourceFiles(fullPath))
    } else if (/\.(?:ts|tsx|js|mjs)$/u.test(entry)) {
      files.push(fullPath)
    }
  }
  return files
}

/**
 * 判断某个位置是否落在注释范围内。
 * @param position 字符偏移。
 * @param commentRanges 已收集的注释范围。
 * @returns 是否位于注释内部。
 * @author zhenghq
 */
function isInComment(position: number, commentRanges: ReadonlyArray<readonly [number, number]>): boolean {
  return commentRanges.some(([start, end]) => position >= start && position < end)
}

/**
 * 判断字符串字面量是否属于允许保留的中文内容。
 * @param file 源文件相对路径。
 * @param text 字符串文本。
 * @param ancestors 从根到当前节点的祖先链。
 * @returns 命中显式白名单或属于日志、注入脚本等内部内容时返回 true。
 * @author zhenghq
 */
function isAllowedFinding(file: string, text: string, ancestors: readonly ts.Node[]): boolean {
  const allowedTexts = ALLOWED_HARDCODED_CHINESE[file]
  if (allowedTexts?.includes(text)) return true

  // 页面注入脚本、日志与诊断输出不进入用户界面。
  if (file === 'src/main/webTextExtractionScript.ts') return true
  for (let index = ancestors.length - 1; index >= 0; index -= 1) {
    const ancestor = ancestors[index]
    if (ts.isCallExpression(ancestor)) {
      const callee = ancestor.expression.getText()
      if (LOG_CALL_PATTERN.test(callee)) return true
      if (callee.endsWith('executeJavaScript')) return true
      break
    }
  }
  return false
}

/**
 * 扫描全部源码文件中的硬编码中文字符串。
 * @returns 按文件与行号排序的发现列表。
 * @author zhenghq
 */
function scanHardcodedChinese(): HardcodedChineseFinding[] {
  const findings: HardcodedChineseFinding[] = []
  const files = SOURCE_ROOTS
    .flatMap((root) => collectSourceFiles(root))
    .filter((file) => !EXCLUDED_DIRECTORIES.some((prefix) => file.startsWith(prefix)))

  for (const file of files) {
    const source = readFileSync(file, 'utf8')
    const sourceFile = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS)
    const commentRanges: Array<readonly [number, number]> = []
    const collectComments = (node: ts.Node): void => {
      for (const range of ts.getLeadingCommentRanges(source, node.getFullStart()) ?? []) {
        commentRanges.push([range.pos, range.end])
      }
      for (const range of ts.getTrailingCommentRanges(source, node.getEnd()) ?? []) {
        commentRanges.push([range.pos, range.end])
      }
      node.forEachChild(collectComments)
    }
    collectComments(sourceFile)

    const visit = (node: ts.Node, ancestors: readonly ts.Node[]): void => {
      const isStringLike =
        ts.isStringLiteral(node) ||
        ts.isNoSubstitutionTemplateLiteral(node) ||
        ts.isTemplateHead(node) ||
        ts.isTemplateMiddle(node) ||
        ts.isTemplateTail(node)
      if (isStringLike && CJK_PATTERN.test(node.text) && !isInComment(node.getStart(sourceFile), commentRanges)) {
        if (!isAllowedFinding(file, node.text, ancestors)) {
          const { line } = sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile))
          findings.push({ file, line: line + 1, text: node.text })
        }
      }
      node.forEachChild((child) => visit(child, [...ancestors, node]))
    }
    visit(sourceFile, [])
  }

  return findings.sort((left, right) => left.file.localeCompare(right.file) || left.line - right.line)
}

test('主进程、Renderer 与共享层不得残留未白名单的用户可见硬编码中文', () => {
  const findings = scanHardcodedChinese()
  assert.deepEqual(
    findings,
    [],
    `发现未白名单的硬编码中文，请在补齐 i18n 词条或按原因加入显式白名单：\n${findings
      .map((finding) => `  ${finding.file}:${finding.line} ${JSON.stringify(finding.text)}`)
      .join('\n')}`
  )
})

test('硬编码中文白名单不得包含过期条目', () => {
  for (const [file, allowedTexts] of Object.entries(ALLOWED_HARDCODED_CHINESE)) {
    const source = readFileSync(file, 'utf8')
    for (const text of allowedTexts) {
      assert.ok(
        source.includes(JSON.stringify(text)) || source.includes(`'${text}'`) || source.includes(text),
        `${file} 的白名单条目已过期：${JSON.stringify(text)}`
      )
    }
  }
})
