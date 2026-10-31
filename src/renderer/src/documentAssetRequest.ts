import type {
  DocumentBlock,
  DocumentBoundingBox,
  DocumentImageBlock,
  DocumentModel
} from '../../shared/documentTypes.ts'

/** PDF 图片在源文件中的定位结果。 */
export interface DocumentPdfImageAssetLocation {
  /** 图片所在页面索引。 */
  pageIndex: number
  /** 图片在页面中的原始边界。 */
  bbox: DocumentBoundingBox
}

/**
 * 判断图片边界是否可用于受控 PDF 资源定位。
 * @param bbox 待检查的图片边界。
 * @returns 坐标有限且尺寸为正时返回 true。
 * @author zhenghq
 */
function isValidImageBoundingBox(
  bbox: DocumentBoundingBox | undefined
): bbox is DocumentBoundingBox {
  return bbox !== undefined &&
    Number.isFinite(bbox.x) && Number.isFinite(bbox.y) &&
    Number.isFinite(bbox.width) && Number.isFinite(bbox.height) &&
    bbox.width > 0 && bbox.height > 0
}

/**
 * 在区块树中查找指定资源标识的图片。
 * @param blocks 待遍历区块。
 * @param assetId 图片资源标识。
 * @returns 匹配的图片区块；不存在时返回 undefined。
 * @author zhenghq
 */
function findImageBlock(
  blocks: readonly DocumentBlock[],
  assetId: string
): DocumentImageBlock | undefined {
  for (const block of blocks) {
    if (block.kind === 'image') {
      if (block.assetId === assetId) return block
      continue
    }
    if (block.kind !== 'table') continue
    for (const row of block.rows) {
      for (const cell of row.cells) {
        const image = findImageBlock(cell.blocks, assetId)
        if (image) return image
      }
    }
  }
  return undefined
}

/**
 * 解析历史 PDF 图片的页面定位。
 *
 * 当前渲染页索引可用时直接使用该页与当前图片边界，避免同一资源跨页重复出现
 * 导致全文档唯一匹配失败；缺少页索引时仅为兼容旧调用保留唯一命中回退。
 * @param model 图片所属的源或译文文档模型。
 * @param block 当前正在渲染的图片区块。
 * @param pageIndex 当前渲染页索引。
 * @returns 可交给受控资源服务的页面定位；非 PDF 或无法安全定位时返回 undefined。
 * @author zhenghq
 */
export function resolveDocumentPdfImageAssetLocation(
  model: DocumentModel | null | undefined,
  block: DocumentImageBlock | null | undefined,
  pageIndex: number | undefined
): DocumentPdfImageAssetLocation | undefined {
  if (model?.source.format !== 'pdf' || !block || !isValidImageBoundingBox(block.bbox)) {
    return undefined
  }
  if (pageIndex !== undefined) {
    if (!Number.isSafeInteger(pageIndex) || pageIndex < 0 ||
      !model.pages.some((page) => page.index === pageIndex)) {
      return undefined
    }
    return { pageIndex, bbox: { ...block.bbox } }
  }

  const matches: DocumentPdfImageAssetLocation[] = []
  for (const page of model.pages) {
    const image = findImageBlock(page.blocks, block.assetId)
    if (!isValidImageBoundingBox(image?.bbox)) continue
    matches.push({ pageIndex: page.index, bbox: { ...image.bbox } })
  }
  return matches.length === 1 ? matches[0] : undefined
}
