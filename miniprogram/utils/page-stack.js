'use strict';
// 页面栈小工具。
//
// wx.redirectTo / wx.navigateBack 作用于"当前栈顶"的页面，而不是发起调用的页面。页面在异步操作（上传头像、
// 开局请求、弹窗）完成后再跳转时，期间可能有别的页面被打开到它上面——例如开局通知（utils/friend-start.js）
// 把对局页推到了栈顶——这时再跳转就会把那个页面关掉。所以异步之后跳转前先用 isTopPage(this) 检查。

function currentPages() {
  try {
    // eslint-disable-next-line no-undef
    return typeof getCurrentPages === 'function' ? getCurrentPages() : null;
  } catch (err) {
    return null;
  }
}

// page 是否仍在栈顶；取不到页面栈时视为是（不拦跳转）
function isTopPage(page) {
  const pages = currentPages();
  if (!Array.isArray(pages) || !pages.length) return true;
  return pages[pages.length - 1] === page;
}

module.exports = { isTopPage };
