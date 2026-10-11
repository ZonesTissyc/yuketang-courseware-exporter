# 本地存储与权限

## Manifest 权限

| 权限 | 用途 |
| --- | --- |
| `tabs` | 检查当前页面，创建和关闭临时打印标签页 |
| `scripting` | 在已登录的雨课堂页面中调用站点接口、写入打印数据 |
| `storage` | 保存任务状态和用户设置 |
| `debugger` | 调用 `Page.printToPDF` 生成 PDF |
| `https://*.yuketang.cn/*` | 访问雨课堂页面、接口、图片和打印页 |

扩展不再使用 `downloads` 权限，PDF 通过用户明确授权的目录句柄写入。

## Chrome Storage

`chrome.storage.local` 当前保存：

- `exportState`：任务状态、进度、统计、错误、标签页 ID 和时间。
- `duplicateMode`：上次选择的宽容或严格模式。

## IndexedDB

目录句柄保存位置：

```text
数据库：yuketang-courseware-exporter
对象仓库：settings
键：export-directory
```

句柄只代表用户主动选择的目录。浏览器重启、权限策略变化或目录移动后，可能需要重新授权。

## 隐私边界

- 课程信息和课件不会上传到第三方服务器。
- 网络请求只发往 Manifest 声明的雨课堂域名。
- 扩展复用现有登录状态，不保存账号密码。
- 文件只写入用户授权目录。
- 扩展不会扫描授权目录之外的本地文件。
