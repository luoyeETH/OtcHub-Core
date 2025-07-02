# OtcHub Smart Contract

OtcHub is a decentralized Over-The-Counter (OTC) escrow platform designed to ensure the security of both trading parties through a dual collateral mechanism.

## Features

  - **Bidirectional Trade Support**: Supports both MakerSells (seller-initiated) and MakerBuys (buyer-initiated) trade directions.
  - **Dual Collateral Mechanism**: Both buyer and seller are required to provide collateral, enhancing transaction security.
  - **Phased Transaction Process**: Open → Funded → Settled/Cancelled/Disputed.
  - **Dispute Resolution**: Supports raising disputes, canceling disputes, and administrator arbitration.
  - **Platform Fees**: Configurable platform transaction fees.
  - **Reentrancy Protection**: Built-in reentrancy attack prevention mechanism.

## Contract Architecture

### Main Contracts

  - `OtcHub.sol`: The primary OTC trading contract.
  - `MockERC20.sol`: An ERC20 token contract used for testing.
  - `interfaces/IERC20.sol`: ERC20 interface definition.

### Trade States

  - `Open`: Trade created, awaiting funding.
  - `Funded`: Both parties have provided funds.
  - `Settled`: Trade completed and settled.
  - `Cancelled`: Trade cancelled.
  - `Disputed`: Trade is under dispute.
  - `AdminClosed`: Administrator has closed the disputed trade.

## Installation and Setup

```bash
# Install dependencies
npm install

# Copy environment file
cp .env.example .env

# Edit .env file with your configurations
```

## Compiling Contracts

```bash
npm run compile
```

## Running Tests

```bash
# Run all tests
npm run test

# Run tests and display gas usage
npm run test:gas

# Run test coverage
npm run test:coverage
```

## Deploying Contracts

### Local Deployment

```bash
# Start local Hardhat network
npm run node

# In another terminal, deploy to local network
npm run deploy:local

# Or use the advanced deployment script
npm run deploy:advanced:local
```

### Testnet Deployment

```bash
# Deploy to Sepolia testnet
npm run deploy:testnet

# Or use the advanced deployment script
npm run deploy:advanced:testnet
```

### Environment Variable Configuration

Configure the following variables in your `.env` file:

```env
# Network Configuration
SEPOLIA_URL=https://sepolia.infura.io/v3/YOUR_INFURA_PROJECT_ID
PRIVATE_KEY=your_private_key_here

# Etherscan Verification
ETHERSCAN_API_KEY=your_etherscan_api_key_here

# Deployment Configuration
ADMIN_ADDRESS=0x...
VAULT_ADDRESS=0x...
INITIAL_PLATFORM_FEE_BPS=50
```

## Contract Verification

```bash
# Verify contract on Sepolia
npm run verify:sepolia <CONTRACT_ADDRESS> <CONSTRUCTOR_ARGS>
```

## Usage Examples

### Create a Trade

```solidity
// Taker creates a MakerSells trade
uint256 tradeId = otcHub.createTrade(
    makerAddress,            // Maker's address
    tokenAddress,            // Collateral token address
    price,                   // Trade price
    deposit,                 // Collateral amount
    fundingWindow,           // Funding window period
    TradeDirection.MakerSells, // Trade direction
    agreementHash            // Agreement hash
);
```

### Fund the Trade

```solidity
// Approve token transfer
token.approve(otcHubAddress, requiredAmount);

// Fund the trade
otcHub.fund(tradeId);
```

### Confirm Trade

```solidity
// Both parties confirm trade completion
otcHub.confirm(tradeId);
```

## Trade Flow

### MakerSells (Seller Initiated)

1.  Taker creates the trade, designating the Maker as the seller.
2.  Maker deposits collateral.
3.  Taker deposits price + collateral.
4.  Both parties complete the offline transaction.
5.  Both parties confirm the trade.
6.  System automatically settles: Maker receives price - fee + collateral, Taker receives collateral.

### MakerBuys (Buyer Initiated)

1.  Taker creates the trade, designating the Maker as the buyer.
2.  Maker deposits price + collateral.
3.  Taker deposits collateral.
4.  Both parties complete the offline transaction.
5.  Both parties confirm the trade.
6.  System automatically settles: Taker receives price - fee + collateral, Maker receives collateral.

## Dispute Resolution

If a trade encounters issues, either party can:

1.  Raise a dispute: `raiseDispute(tradeId)`
2.  Cancel a dispute: `cancelDispute(tradeId)` (only by the party who raised the dispute)
3.  Administrator intervention: `adminWithdraw(tradeId)` (only by the administrator)

## Security Considerations

### Implemented Security Measures

  - Reentrancy attack protection
  - Address validation
  - State checks
  - Access control

### Potential Risks and Recommendations

1.  **Missing Pause Mechanism**: No emergency pause function is implemented.
2.  **Fee Calculation Overflow**: Numerical overflow may occur in extreme cases.
3.  **Fund Locking Risk**: If the administrator does not handle a dispute, funds may be permanently locked.

## License

MIT License