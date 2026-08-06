# VIVBLOOM 部署手册

## 1. Vercel 项目创建

1. 登录 https://vercel.com
2. 点 **Add New → Project**
3. 选择 **Import Git Repository**，找到 `VivianLu0220.github.io` 仓库
4. 配置：
   - **Framework Preset**: Other
   - **Build Command**: 留空（纯静态，不需要构建）
   - **Output Directory**: 留空（根目录即站点）
5. 点 **Deploy**

部署成功后会得到一个 `*.vercel.app` 域名。

## 2. 设置环境变量

进入 Vercel 项目 → **Settings → Environment Variables**，添加：

| 变量名 | 值 | 说明 |
|--------|-----|------|
| `FAL_KEY` | `fal-xxxxxxxx` | fal.ai API Key（Dashboard → Keys） |
| `LORA_URL` | `https://v3b.fal.media/files/b/0aa549b0/a1kYd4tMSaBU7d5CScwCf_pytorch_lora_weights.safetensors` | LoRA 权重文件 URL |
| `LORA_SCALE` | `1.0` | LoRA 强度 |

添加后点 **Save**，然后去 **Deployments** 页面点最新一次部署的 **Redeploy**（环境变量需要重新部署才生效）。

## 3. 验收 Checklist

### 静态页面

- [ ] 首页 `index.html` 正常加载
- [ ] `cv.html` 正常加载
- [ ] `flowers.html` 正常加载，所有花束图片显示
- [ ] `chat.html` 正常加载
- [ ] `donate/index.html` 正常加载
- [ ] `bouquet.html` 正常加载，花材标签可点击
- [ ] 站内所有链接无死链

### 花束生成器

- [ ] 选 1–5 种花 → 点 Generate → 20–30 秒后出图
- [ ] 不选花时按钮为灰色不可点击
- [ ] 选超过 5 种时不再允许新增
- [ ] 生成图下方标注 "AI-generated in Vivian's style"
- [ ] "See real works" 链接跳转到 flowers.html

### 限流与安全

- [ ] 同一 IP 第 6 次生成返回 429 友好提示
- [ ] 从其他域名直接 POST `/api/generate` 返回 403
- [ ] 传入非白名单花材返回 400 错误
- [ ] 仓库代码中搜索不到任何 API key

## 4. 域名（可选）

### 方案 A：使用 Vercel 分配的域名

不做任何额外操作，站点在 `your-project.vercel.app` 运行。

### 方案 B：自定义域名

1. 购买域名（如 Namecheap、Cloudflare）
2. Vercel 项目 → **Settings → Domains** → 添加域名
3. 按 Vercel 提示在域名注册商处添加 DNS 记录
4. 等待 DNS 生效（通常 5–30 分钟）

### 停用 GitHub Pages

全站切到 Vercel 后：
1. GitHub 仓库 → **Settings → Pages**
2. Source 改为 **None**，保存
3. 或在仓库根目录放一个跳转页面指向新域名

## 5. 费用参考

| 项目 | 费用 |
|------|------|
| Vercel Hobby 套餐 | 免费 |
| Serverless Function 调用 | 免费额度内（100k 次/月） |
| fal.ai 单次生成 | ~$0.05 |
| 每日 200 次上限成本 | ~$10/天（极端情况） |
| 每日 5 次/IP 限制下实际成本 | 远低于上限 |
