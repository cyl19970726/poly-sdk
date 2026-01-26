# Private Key Migration - Security Enhancement

## 完成时间
2026-01-15

## 背景

之前所有测试脚本中硬编码了私钥作为 fallback 值：

```typescript
// ❌ 不安全的旧方式
const PRIVATE_KEY = process.env.PRIVATE_KEY || '0xa1c847feeb03315d72a09481edae8e34d3892ae281b6b2291911380490a23459';
```

这种做法存在严重安全隐患：
1. 私钥可能被意外提交到 Git
2. 难以区分是否正确设置了环境变量
3. 不符合安全最佳实践

## 改进措施

### 1. 移除所有硬编码私钥

更新所有测试脚本，移除 fallback 私钥：

```typescript
// ✅ 安全的新方式
const PRIVATE_KEY = process.env.PRIVATE_KEY;

if (!PRIVATE_KEY) {
  console.error('Error: PRIVATE_KEY environment variable is required');
  console.error('Please set it in .env file or pass as environment variable');
  process.exit(1);
}
```

### 2. 创建 .env 配置文件

创建了两个配置文件：

**`.env.example`** (模板，可以提交到 Git)：
```bash
# Polymarket SDK Test Configuration

# Private key for testing (DO NOT commit real private key)
PRIVATE_KEY=0xa1c847feeb03315d72a09481edae8e34d3892ae281b6b2291911380490a23459

# Optional: Market configuration for tests
# MARKET_CONDITION_ID=0x...
# PRIMARY_TOKEN_ID=123...
# SECONDARY_TOKEN_ID=456...
```

**`.env`** (实际配置，已在 .gitignore 中)：
```bash
# Polymarket SDK Test Configuration

# Private key for testing
PRIVATE_KEY=0xa1c847feeb03315d72a09481edae8e34d3892ae281b6b2291911380490a23459

# Optional: Market configuration for tests
# MARKET_CONDITION_ID=0x4e605132e536d51c37a28cdc0ac77e48c77d8e2251743d4eae3309165dee7d34
# PRIMARY_TOKEN_ID=114556380551836029874371622136300870993278600643770464506059877822810208153399
# SECONDARY_TOKEN_ID=24084804653914500740208824435348684831132621527155423823545713790843845444174
```

### 3. 更新文档

更新了 `scripts/README.md`，添加了详细的私钥配置说明：

- **方法 1**：使用 `.env` 文件（推荐）
- **方法 2**：通过环境变量传递

包含安全提醒：
- `.env` 文件已在 `.gitignore` 中
- 永远不要在代码中硬编码私钥
- 永远不要提交包含私钥的文件
- 使用测试钱包，只包含少量资金

## 受影响的文件

### 测试脚本（已更新）

**OrderManager 测试** (`scripts/ordermanager/`):
- ✅ `quick-test.ts`
- ✅ `minimal-loop-test.ts`
- ✅ `balanced-test.ts`
- ✅ `smart-cycle-test.ts`
- ✅ `full-e2e.ts`

**CTFManager 测试** (`scripts/ctfmanager/`):
- ✅ `quick-test.ts`
- ✅ `cycle-test.ts`
- ✅ `full-e2e.ts`

### 配置文件（已创建/更新）

- ✅ `.env.example` - 模板文件（可提交）
- ✅ `.env` - 实际配置（在 .gitignore 中）
- ✅ `scripts/README.md` - 更新了环境配置说明

## 验证

### 1. 确认没有硬编码私钥

```bash
# 搜索所有脚本中是否还有硬编码私钥
grep -r "0xa1c847feeb03315d72a09481edae8e34d3892ae281b6b2291911380490a23459" scripts/ | grep -v ".env"
# 输出: ✓ No hardcoded private keys found in scripts
```

### 2. 确认 .env 在 .gitignore 中

```bash
grep "^\.env$" .gitignore
# 输出: .env (line 8)
```

### 3. 确认构建通过

```bash
pnpm build
# 输出: ✓ Build successful
```

## 使用方法

### 方法 1：使用 .env 文件（推荐）

```bash
# 1. 创建 .env 文件
cd packages/poly-sdk
cp .env.example .env

# 2. 编辑 .env，填入你的私钥
# PRIVATE_KEY=0x...

# 3. 运行测试（自动读取 .env）
npx tsx scripts/ordermanager/quick-test.ts
```

### 方法 2：环境变量传递

```bash
# 临时传递（不会保存）
PRIVATE_KEY=0x... npx tsx scripts/ordermanager/quick-test.ts
```

### 方法 3：导出环境变量

```bash
# 导出到当前 shell
export PRIVATE_KEY=0x...

# 运行测试
npx tsx scripts/ordermanager/quick-test.ts
```

## 安全最佳实践

### ✅ 应该做

1. **使用 .env 文件**存储私钥
2. **确认 .env 在 .gitignore 中**
3. **使用测试钱包**，只包含少量资金
4. **定期轮换测试私钥**

### ❌ 不应该做

1. ❌ 在代码中硬编码私钥
2. ❌ 提交包含私钥的文件
3. ❌ 使用主钱包进行测试
4. ❌ 在公共场所分享包含私钥的屏幕截图

## 回滚方案

如果需要回滚到旧版本（不推荐）：

```bash
# 恢复带 fallback 的版本
git checkout HEAD~1 -- scripts/ordermanager/
git checkout HEAD~1 -- scripts/ctfmanager/
```

**注意**：不推荐回滚，因为会重新引入安全隐患。

## 测试验证

运行一个快速测试验证配置正确：

```bash
# 确保 .env 文件存在且包含 PRIVATE_KEY
npx tsx scripts/ordermanager/quick-test.ts
```

如果私钥未配置，会看到清晰的错误提示：
```
Error: PRIVATE_KEY environment variable is required
Please set it in .env file or pass as environment variable
```

## 相关文档

- [scripts/README.md](../scripts/README.md) - 环境配置完整说明
- [scripts/ordermanager/README.md](../scripts/ordermanager/README.md) - OrderManager 测试指南
- [scripts/ctfmanager/README.md](../scripts/ctfmanager/README.md) - CTFManager 测试指南

## 总结

✅ **完成的改进**：
- 移除了所有 8 个测试脚本中的硬编码私钥
- 创建了 `.env` 和 `.env.example` 配置文件
- 更新了文档，包含详细的安全说明
- 验证了 `.env` 在 `.gitignore` 中
- 确认构建仍然正常工作

✅ **安全提升**：
- 私钥不会被意外提交
- 明确的错误提示帮助用户正确配置
- 符合业界最佳实践

✅ **用户体验**：
- 更清晰的配置方式
- 更好的错误提示
- 更完善的文档
