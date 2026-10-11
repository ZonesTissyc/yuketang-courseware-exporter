# 整体架构

## 运行形态

项目是一个无构建流程的 Chromium Manifest V3 扩展，使用原生 ES Modules。浏览器直接加载仓库中的 JavaScript、HTML 和 CSS 文件。

```text
manifest.json
├── popup.html → popup.js
└── background.js（Service Worker）
    └── src/
        ├── services/   雨课堂接口
        ├── storage/    目录句柄和任务状态
        └── shared/     平台识别与通用格式化
```

## 模块职责

### 弹窗入口

`popup.js` 负责界面交互：

- 识别当前雨课堂平台。
- 展示课程和课件列表。
- 管理日期范围、勾选状态和重复处理模式。
- 管理课程归档筛选、确认和恢复交互。
- 发起目录授权。
- 向后台发送任务消息。
- 根据 `chrome.storage.local` 的变化刷新进度。

### 后台入口

`background.js` 负责任务编排：

- 接收弹窗消息。
- 将课堂活动转换成课件导出任务。
- 控制取消、进度、错误和完成状态。
- 调用打印页生成 PDF。
- 检查本地重复文件并写入授权目录。

### 雨课堂接口

`src/services/yuketang-api.js` 负责：

- 校验当前标签页是否属于 `*.yuketang.cn`。
- 在页面主世界执行带登录态的请求。
- 标准化课程数据。
- 读取归档课程并提交归档或恢复操作。
- 分页读取课堂活动和课件列表。

接口请求通过 `chrome.scripting.executeScript` 注入当前页面的主世界执行，从而复用网站已有的 Cookie 和登录状态。

### 存储模块

- `src/storage/directory-store.js`：使用 IndexedDB 保存用户授权的目录句柄。
- `src/storage/task-state.js`：使用 `chrome.storage.local` 保存任务状态，并提供读取、更新和重置方法。

### 共享模块

- `src/shared/platform.js`：识别雨课堂域名和平台名称。
- `src/shared/format.js`：日期格式化和文件名清理。

## 消息协议

弹窗和后台通过以下消息通信：

| 消息 | 用途 |
| --- | --- |
| `GET_STATE` | 获取当前任务状态 |
| `SCAN_COURSES` | 获取课程列表 |
| `SCAN_LESSONS` | 获取单门课程的课堂课件 |
| `SCAN_ARCHIVED_COURSES` | 获取“我的归档”课程列表 |
| `SET_COURSE_ARCHIVED` | 批量归档或恢复课程 |
| `START_EXPORT` | 启动课件导出任务 |
| `CANCEL_EXPORT` | 请求停止当前任务 |

## 任务状态

任务状态包括：

- `idle`：无任务。
- `scanning`：扫描课堂或识别课件。
- `running`：逐个生成和写入 PDF。
- `done`：任务完成。
- `error`：任务整体失败。
- `cancelled`：用户停止任务。

当前扩展同一时间只运行一个后台任务。刷新任务所属的标签页时，只清除已经结束的状态，不清除仍在执行的任务。

## 扩展新功能的原则

课程归档复用平台识别、课程扫描和雨课堂 API 层，但不使用本地目录，也不加入课件导出任务。学期推导和关键词筛选位于独立的纯逻辑模块，归档读写使用独立消息类型。
