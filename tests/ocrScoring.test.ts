import assert from 'node:assert/strict'
import test from 'node:test'
import { chooseBetterOcrText, isMostlyNoise, scoreOcrText } from '../src/shared/ocrScoring.ts'

/**
 * 校验空文本得分为 0。
 * @returns 无返回值。
 * @author zhenghq
 */
test('空文本质量分应为 0', () => {
  assert.equal(scoreOcrText(''), 0)
  assert.equal(scoreOcrText('   '), 0)
})

/**
 * 校验中文文本因加权而比同等长度拉丁文本得分更高。
 * @returns 无返回值。
 * @author zhenghq
 */
test('中文文本应获得比拉丁文本更高的质量分', () => {
  assert.ok(scoreOcrText('中文文本测试') > scoreOcrText('abcdef'))
})

/**
 * 校验乱码替换符与方块字符会显著拉低质量分。
 * @returns 无返回值。
 * @author zhenghq
 */
test('乱码字符应显著拉低质量分', () => {
  assert.ok(scoreOcrText('中文文本测试') > scoreOcrText('中文\ufffd\ufffd测试'))
  assert.ok(scoreOcrText('中文文本测试') > scoreOcrText('中文□□测试'))
})

/**
 * 校验空文本、单字符与低信号文本被判定为噪声。
 * @returns 无返回值。
 * @author zhenghq
 */
test('空文本与低信号文本应判定为噪声', () => {
  assert.equal(isMostlyNoise(''), true)
  assert.equal(isMostlyNoise('a'), true)
  assert.equal(isMostlyNoise('\ufffd\ufffd\ufffd'), true)
  assert.equal(isMostlyNoise('ab\ufffd\ufffd'), true)
  assert.equal(isMostlyNoise('abc' + '-'.repeat(20)), true)
})

/**
 * 校验 PaddleOCR 将英文日志误识别成罕见汉字串时会被判定为噪声。
 * @returns 无返回值。
 * @author zhenghq
 */
test('罕见汉字组成的 Paddle 乱码应判定为噪声', () => {
  const garbled = [
    '原蹿眼晏录科里东2瞠珈唐阶灿爸梓航1航晏眼汇消',
    '原汇捌傍蹿2蛰钻险酱捌字晏科韵里傍盎盎眼里计网捌愉航眼晏',
    '原捌字晏科韵里傍盎盎眼里2薯興慈育灿蛰钻 唐玲嶺税'
  ].join('\n')
  assert.equal(isMostlyNoise(garbled), true)
})

/**
 * 校验 PaddleOCR 将英文代码截图误识别成重复罕见汉字串时会被判定为噪声。
 * @returns 无返回值。
 * @author zhenghq
 */
test('重复罕见汉字组成的 Paddle 英文乱码应判定为噪声', () => {
  const garbled = [
    '里眼晏字里蹿眼愉眼拳晏里科蹿奉瘸眼蹿字奉备字傍愉伺处里科汇韵眼汇每愉捌晏眼贿原',
    '7愉捌备眼愉薯興携門 诚7航眼晏晏傍蹿盎航奉大科晏东眼1>-纳眼蹿捌备愉眼伺一网捌愉航眼>纳',
    '7晏1每眼一疗航眼每捌里捌晏科里疗>纳',
    '7愉捌备眼愉一疗贱钻携奉奉疗纳拳愉傍拳东一贿者一平科傍伺计与科每眼蹿瘸捌蹿字捌愉韵里捌蹿航愉捌晏傍科蹿贿者>',
    '7晏1每眼一疗航眼每捌里捌晏科里疗>纳',
    '网',
    '愉捌备眼愉疗薯興承婷钻薰皇来門霓娠丄疗',
    '晏1每眼一疗拳大眼拳东备科先疗',
    '拳大眼拳东眼伺一航眼晏晏傍蹿捌航奉晏里傍捌盎眼里瘸科伺眼计计计疗备字晏晏科蹿疗奉'
  ].join('\n')
  assert.equal(isMostlyNoise(garbled), true)
})

/**
 * 校验 PaddleOCR 将英文短行误识别成夹杂字母符号的罕见汉字串时会被判定为噪声。
 * @returns 无返回值。
 * @author zhenghq
 */
test('夹杂少量字母符号的 Paddle 罕见汉字乱码应判定为噪声', () => {
  const garbled = '缬巧Й誠僚虚汰昵糠贈爪意嘿孛匾承忒藩郢减捋婧烬侍★唛虑殻樂唉x'
  assert.equal(isMostlyNoise(garbled), true)
})

/**
 * 校验 PP-OCRv6_tiny 对正常中文网页截图产生的混合乱码会被判定为噪声。
 * @returns 无返回值。
 * @author zhenghq
 */
test('PP-OCRv6_tiny 混合全角符号乱码应判定为噪声', () => {
  const garbled = [
    'qＭ胍罘凄 与处傍蹿眼月傍航 揉贰即 备月 ，]，全涸匾升忐´舅全栈揉贰即宫丈Ｍ意珍酥鄂减',
    '門',
    '，]，全涸匾升忐´舅全栈揉贰即宫丈Ｍ意珍酥鄂减',
    '揉贰即耐略 揉贰即宫丈',
    '处傍蹿眼月傍航煥诒尐檸悲帕挝堤，]，全涸，赌，昏掖,,一全刈一刈全 蕒勅鬣毒一刈傈消昏 凈觊蕒勅君郵一消汇傍蹿'
  ].join('\n')
  assert.equal(isMostlyNoise(garbled), true)
})

/**
 * 校验正常中英文文本不被判定为噪声。
 * @returns 无返回值。
 * @author zhenghq
 */
test('正常中英文文本不应判定为噪声', () => {
  assert.equal(isMostlyNoise('hello world'), false)
  assert.equal(isMostlyNoise('中文内容识别'), false)
  assert.equal(isMostlyNoise('The quick brown fox jumps.'), false)
})

/**
 * 校验择优逻辑返回质量分更高的文本，空候选不覆盖现有文本。
 * @returns 无返回值。
 * @author zhenghq
 */
test('择优逻辑应返回质量分更高的文本', () => {
  assert.equal(chooseBetterOcrText('中文识别结果', 'a'), '中文识别结果')
  assert.equal(chooseBetterOcrText('a', '中文识别结果'), '中文识别结果')
  assert.equal(chooseBetterOcrText('现有文本', ''), '现有文本')
  assert.equal(chooseBetterOcrText('', '新文本'), '新文本')
  assert.equal(chooseBetterOcrText('', ''), '')
})

/**
 * 校验乱码候选不会覆盖正常文本。
 * @returns 无返回值。
 * @author zhenghq
 */
test('乱码候选不应覆盖正常文本', () => {
  assert.equal(
    chooseBetterOcrText('识别出来的正常句子', '\ufffd\ufffd□□\ufffd'),
    '识别出来的正常句子'
  )
})
