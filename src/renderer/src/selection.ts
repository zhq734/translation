const translateButton = document.getElementById('translate') as HTMLButtonElement

/**
 * 响应选区旁“译”按钮点击，并请求主进程捕获当前选中文字。
 * @returns 无返回值。
 * @author zhenghq
 */
function translateSelection(): void {
  window.api.translateSelection()
}

translateButton.addEventListener('click', translateSelection)
