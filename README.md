# 密码管理器 · Chrome / Edge

以 **桌面版 Google Chrome** 为主要目标，兼容 Chromium 版 Microsoft Edge。当前版本 **v1.1.3**，支持 WebDAV 加密同步；两种浏览器加载同一个插件目录即可。

支持手动双向同步、可选的每 15 分钟自动同步、冲突保护与覆盖前备份。

Chrome 安装入口：`chrome://extensions/` →「开发者模式」→「加载已解压的扩展程序」→ 选择包含 `manifest.json` 的文件夹。Edge 对应入口为 `edge://extensions/`。

安装、跨浏览器迁移和同步配置请阅读 [WebDAV 使用说明](./WEBDAV使用说明.md)。

[密码管理器 - Microsoft Edge Addons](https://microsoftedge.microsoft.com/addons/detail/calbgkmccbdhjeclopclefheknmikpkg)


<img width="492" alt="Snipaste_2025-01-03_16-49-15" src="https://github.com/user-attachments/assets/26184602-91ff-4ac4-a97a-73a8789a7295" />



### 功能介绍：

- 保存网站账号/密码，需要输入账号/密码时，只需要点一下填充即可

- 数据完全以JSON格式存在本地，支持导入/导出。

- 支持多站点关联，多个站点可共用一套密码

- 支持快捷键 alt1~5 快速填充前5个账号

- 支持自定义匹配规则


#### 站点关联功能说明：

`必须有一个主站点，在主站点进行关联。例如：a.com 作为主站点，关联 b.com、b.com 作为子站点`

关联后：
   - b.com、c.com 原数据会合并到 a.com 下，原b、c的数据会丢失，不能恢复。
   - 强绑定，操作任意站点，三个站点的账号数据都会变化。
   - 子站点不能再进行关联站点操作，只能在主站点进行。

注意：b.com、c.com作为子站点，不能再关联其他站点，否则子站点会出现账号`列表空白`的情况。需要导出json清理关联关系，重新导入恢复正常。



#### 自定义规则：

```json
// 对于一些彻底没救的网站，可以使用css选择器强行查找元素
// 先通过域名匹配，再通过css选择器查找元素
{
  "exmail.qq.com": {
    "passwordSelector": "input[name='pp']",
    "usernameSelector": "input[name='inputuin']"
  },
  "abc.com": {
    "passwordSelector": "#p",
    "usernameSelector": "#u"
  }
}

```


```
1、方便的本地管理各个网站账号密码，尤其适合频繁切换多个账号的场景。
2、可以关联多个站点，多站点共用一套账号密码。（开发环境、测试环境、生产环境绑定一套密码，不用再单独管理）
3、本地账号及 JSON 导出为明文；开启 WebDAV 同步后，上传到云端的文件使用独立口令加密
4、注意做好备份，避免数据丢失（导出json文件，妥善保存）。
适合场景
例如：开发测试人员多账号切换、本地保存密码，或自选 WebDAV 服务进行加密同步
```
