# OtcHub Smart Contract

OtcHub是一个去中心化的场外交易(OTC)托管平台，通过双重抵押机制确保交易双方的安全。

## 功能特性

- **双向交易支持**: 支持MakerSells（卖方发起）和MakerBuys（买方发起）两种交易方向
- **双重抵押机制**: 买卖双方都需要提供抵押金，增强交易安全性
- **分阶段交易流程**: Open → Funded → Settled/Cancelled/Disputed
- **争议处理**: 支持争议提起、取消和管理员仲裁
- **平台费用**: 可配置的平台交易费用
- **重入攻击防护**: 内置重入攻击保护机制

## 合约架构

### 主要合约
- `OtcHub.sol`: 主要的OTC交易合约
- `MockERC20.sol`: 用于测试的ERC20代币合约
- `interfaces/IERC20.sol`: ERC20接口定义

### 交易状态
- `Open`: 交易已创建，等待资金注入
- `Funded`: 双方都已注入资金
- `Settled`: 交易已完成结算
- `Cancelled`: 交易已取消
- `Disputed`: 交易存在争议
- `AdminClosed`: 管理员已关闭争议交易

## 安装和设置

```bash
# 安装依赖
npm install

# 复制环境变量文件
cp .env.example .env

# 编辑.env文件，填入你的配置
```

## 编译合约

```bash
npm run compile
```

## 运行测试

```bash
# 运行所有测试
npm run test

# 运行测试并显示gas使用情况
npm run test:gas

# 运行测试覆盖率
npm run test:coverage
```

## 部署合约

### 本地部署

```bash
# 启动本地Hardhat网络
npm run node

# 在另一个终端部署到本地网络
npm run deploy:local

# 或使用高级部署脚本
npm run deploy:advanced:local
```

### 测试网部署

```bash
# 部署到Sepolia测试网
npm run deploy:testnet

# 或使用高级部署脚本
npm run deploy:advanced:testnet
```

### 环境变量配置

在`.env`文件中配置以下变量：

```env
# 网络配置
SEPOLIA_URL=https://sepolia.infura.io/v3/YOUR_INFURA_PROJECT_ID
PRIVATE_KEY=your_private_key_here

# Etherscan验证
ETHERSCAN_API_KEY=your_etherscan_api_key_here

# 部署配置
ADMIN_ADDRESS=0x...
VAULT_ADDRESS=0x...
INITIAL_PLATFORM_FEE_BPS=50
```

## 合约验证

```bash
# 在Sepolia上验证合约
npm run verify:sepolia <CONTRACT_ADDRESS> <CONSTRUCTOR_ARGS>
```

## 使用示例

### 创建交易

```solidity
// Taker创建一个MakerSells交易
uint256 tradeId = otcHub.createTrade(
    makerAddress,           // maker地址
    tokenAddress,           // 抵押代币地址
    price,                  // 交易价格
    deposit,                // 抵押金额
    fundingWindow,          // 资金注入窗口期
    TradeDirection.MakerSells, // 交易方向
    agreementHash           // 协议哈希
);
```

### 注入资金

```solidity
// 批准代币转账
token.approve(otcHubAddress, requiredAmount);

// 注入资金
otcHub.fund(tradeId);
```

### 确认交易

```solidity
// 双方确认交易完成
otcHub.confirm(tradeId);
```

## 交易流程

### MakerSells（卖方发起）
1. Taker创建交易，指定Maker为卖方
2. Maker注入抵押金
3. Taker注入价格+抵押金
4. 双方线下完成交易
5. 双方确认交易
6. 系统自动结算：Maker获得价格-手续费+抵押金，Taker获得抵押金

### MakerBuys（买方发起）
1. Taker创建交易，指定Maker为买方
2. Maker注入价格+抵押金
3. Taker注入抵押金
4. 双方线下完成交易
5. 双方确认交易
6. 系统自动结算：Taker获得价格-手续费+抵押金，Maker获得抵押金

## 争议处理

如果交易出现问题，任一方可以：

1. 提起争议：`raiseDispute(tradeId)`
2. 取消争议：`cancelDispute(tradeId)` (仅争议发起方)
3. 管理员介入：`adminWithdraw(tradeId)` (仅管理员)

## 安全考虑

### 已实现的安全措施
- 重入攻击防护
- 地址验证
- 状态检查
- 权限控制

### 潜在风险和建议
1. **缺少暂停机制**: 未实现紧急暂停功能
2. **费用计算溢出**: 在极端情况下可能出现数值溢出
3. **资金锁定风险**: 如果争议后管理员不处理，资金可能永久锁定

## 许可证

MIT License
