# 跨设备同步配置

这个刷题页默认仍可离线使用。要开启电脑和手机同步，需要先配置 Supabase。

## 1. 创建 Supabase 项目

1. 在 Supabase 新建项目。
2. 打开 SQL Editor，执行 `supabase-schema.sql`。
3. 在 Authentication 的 URL 配置里加入本地测试地址和 GitHub Pages 地址：
   - `http://127.0.0.1:4173/刷题网页/index.html`
   - `https://fionapia.github.io/cpa-youth-challenge-study-web/`

## 2. 填写前端配置

在 `sync-config.js` 填入项目配置：

```js
window.SUPABASE_SYNC_CONFIG = {
  url: "https://你的项目.supabase.co",
  anonKey: "你的 anon public key",
};
```

`anonKey` 可以放在前端，安全边界依赖 `supabase-schema.sql` 里的 RLS 策略：登录用户只能读写自己的 `user_id` 行。

## 3. 使用方式

1. 打开刷题页，输入邮箱点击“开启同步”。
2. 在电脑或手机里打开邮件链接。
3. 两台设备使用同一个邮箱后，统计、错题、答题记录和个人解析会自动合并。
