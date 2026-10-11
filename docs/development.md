# 开发与验证

## 环境要求

- Microsoft Edge、Google Chrome 或其他支持 Manifest V3 和 File System Access API 的 Chromium 浏览器。
- Node.js，仅用于本地 JavaScript 语法检查。

项目没有依赖安装和构建步骤。

## 加载扩展

1. 打开 `edge://extensions/` 或 `chrome://extensions/`。
2. 开启开发人员模式。
3. 选择“加载解压缩的扩展”。
4. 选择包含 `manifest.json` 的仓库目录。
5. 代码修改后点击扩展的“重新加载”。

## 基础检查

```powershell
node --check background.js
node --check popup.js
node --check src/services/yuketang-api.js
node --check src/storage/directory-store.js
node --check src/storage/task-state.js
node --check src/shared/platform.js
node --check src/shared/format.js
git diff --check
```

## 手工回归清单

- 长江雨课堂可以读取课程和当前课程标记。
- 其他雨课堂显示兼容性提示。
- 单课程和多课程配置正常。
- 日期过滤和逐课件勾选正常。
- 目录首次授权、恢复授权和更换目录正常。
- 宽容模式跳过同名文件。
- 严格模式跳过同大小文件，并为不同大小文件选择新序号。
- PDF 页面方向正确且所有图片完整。
- 取消任务、单项失败和整体失败状态正确。
- 页面刷新后不显示旧的终态消息。

## 模块约定

- `popup.js` 只处理界面和用户操作。
- `background.js` 只负责任务编排和消息路由。
- 站点接口放入 `src/services/`。
- 持久化逻辑放入 `src/storage/`。
- 无浏览器业务依赖的通用代码放入 `src/shared/`。
- 新功能先更新对应中文文档，再修改代码。
