import { ethers } from "hardhat";
import fs from "fs";
import path from "path";

interface DeploymentConfig {
  admin?: string;
  vault?: string;
  platformFeeBps?: number;
}

interface NetworkConfig {
  [key: string]: DeploymentConfig;
}

const networkConfigs: NetworkConfig = {
  localhost: {
    platformFeeBps: 50, // 0.5%
  },
  sepolia: {
    platformFeeBps: 50, // 0.5%
  },
  mainnet: {
    platformFeeBps: 30, // 0.3% for mainnet
  },
};

async function main() {
  console.log("Starting advanced OtcHub deployment...");

  // Get network info
  const network = await ethers.provider.getNetwork();
  const networkName = network.name === "unknown" ? "localhost" : network.name;
  
  console.log(`Deploying to network: ${networkName} (Chain ID: ${network.chainId})`);

  // Get the deployer account
  const [deployer] = await ethers.getSigners();
  console.log("Deploying contracts with the account:", deployer.address);
  console.log("Account balance:", ethers.formatEther(await ethers.provider.getBalance(deployer.address)), "ETH");

  // Get network-specific config
  const config = networkConfigs[networkName] || networkConfigs.localhost;
  
  // Use environment variables or defaults
  const admin = process.env.ADMIN_ADDRESS || config.admin || deployer.address;
  const vault = process.env.VAULT_ADDRESS || config.vault || deployer.address;
  const platformFeeBps = process.env.INITIAL_PLATFORM_FEE_BPS 
    ? parseInt(process.env.INITIAL_PLATFORM_FEE_BPS) 
    : config.platformFeeBps || 50;

  console.log("\nDeployment parameters:");
  console.log("Admin address:", admin);
  console.log("Vault address:", vault);
  console.log("Platform fee:", platformFeeBps, "bps (", platformFeeBps / 100, "%)");

  // Validate addresses
  if (!ethers.isAddress(admin)) {
    throw new Error("Invalid admin address");
  }
  if (!ethers.isAddress(vault)) {
    throw new Error("Invalid vault address");
  }
  if (platformFeeBps < 0 || platformFeeBps > 1000) { // Max 10%
    throw new Error("Platform fee must be between 0 and 1000 bps");
  }

  // Deploy OtcHub contract
  console.log("\nDeploying OtcHub contract...");
  const OtcHub = await ethers.getContractFactory("OtcHub");
  
  // Estimate gas
  const deploymentData = OtcHub.interface.encodeDeploy([admin, vault, platformFeeBps]);
  const estimatedGas = await ethers.provider.estimateGas({
    data: deploymentData,
  });
  console.log("Estimated gas for deployment:", estimatedGas.toString());

  const otcHub = await OtcHub.deploy(admin, vault, platformFeeBps);
  console.log("Transaction hash:", otcHub.deploymentTransaction()?.hash);
  
  await otcHub.waitForDeployment();
  const otcHubAddress = await otcHub.getAddress();

  console.log("OtcHub deployed to:", otcHubAddress);

  // Deploy test token for non-mainnet networks
  let mockTokenAddress = "";
  if (networkName !== "mainnet") {
    console.log("\nDeploying MockERC20 for testing...");
    const MockERC20 = await ethers.getContractFactory("MockERC20");
    const mockToken = await MockERC20.deploy(
      "Test Token",
      "TEST",
      18,
      ethers.parseUnits("1000000", 18) // 1M tokens
    );

    await mockToken.waitForDeployment();
    mockTokenAddress = await mockToken.getAddress();

    console.log("MockERC20 deployed to:", mockTokenAddress);

    // Mint some tokens to deployer for testing
    console.log("Minting test tokens to deployer...");
    await mockToken.mint(deployer.address, ethers.parseUnits("10000", 18));
    
    console.log("Test token balance of deployer:", 
      ethers.formatUnits(await mockToken.balanceOf(deployer.address), 18), "TEST");
  }

  // Verify deployment
  console.log("\nVerifying deployment...");
  console.log("OtcHub admin:", await otcHub.admin());
  console.log("OtcHub vault:", await otcHub.vault());
  console.log("OtcHub platform fee:", await otcHub.platformFeeBps(), "bps");

  // Save deployment info
  const deploymentInfo = {
    network: networkName,
    chainId: network.chainId.toString(),
    contracts: {
      otcHub: otcHubAddress,
      mockToken: mockTokenAddress || null,
    },
    config: {
      admin: admin,
      vault: vault,
      platformFeeBps: platformFeeBps,
    },
    deployment: {
      deployer: deployer.address,
      deployedAt: new Date().toISOString(),
      gasUsed: estimatedGas.toString(),
    }
  };

  // Save to file
  const deploymentsDir = path.join(__dirname, "..", "deployments");
  if (!fs.existsSync(deploymentsDir)) {
    fs.mkdirSync(deploymentsDir);
  }

  const deploymentFile = path.join(deploymentsDir, `${networkName}.json`);
  fs.writeFileSync(deploymentFile, JSON.stringify(deploymentInfo, null, 2));

  console.log("\n✅ Deployment completed successfully!");
  console.log(`Deployment info saved to: ${deploymentFile}`);
  
  console.log("\nDeployment Summary:");
  console.log(JSON.stringify(deploymentInfo, null, 2));

  // Instructions for next steps
  console.log("\n📋 Next Steps:");
  console.log("1. Verify the contract on Etherscan (if on testnet/mainnet)");
  console.log("2. Run tests: npm run test");
  console.log("3. Update frontend configuration with new contract addresses");
  
  if (networkName !== "mainnet") {
    console.log("4. Use the MockERC20 token for testing trades");
  }
}

// We recommend this pattern to be able to use async/await everywhere
// and properly handle errors.
main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
