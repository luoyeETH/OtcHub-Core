import { ethers } from "hardhat";

async function main() {
  console.log("Starting OtcHub deployment...");

  // Get the deployer account
  const [deployer] = await ethers.getSigners();
  console.log("Deploying contracts with the account:", deployer.address);
  console.log("Account balance:", (await ethers.provider.getBalance(deployer.address)).toString());

  // Deploy parameters
  const admin = deployer.address; // In production, this should be a different address
  const vault = deployer.address; // In production, this should be a treasury address
  const initialFeeBps = 50; // 0.5% platform fee

  console.log("\nDeployment parameters:");
  console.log("Admin address:", admin);
  console.log("Vault address:", vault);
  console.log("Initial platform fee:", initialFeeBps, "bps (", initialFeeBps / 100, "%)");

  // Deploy OtcHub contract
  console.log("\nDeploying OtcHub contract...");
  const OtcHub = await ethers.getContractFactory("OtcHub");
  const otcHub = await OtcHub.deploy(admin, vault, initialFeeBps);

  await otcHub.waitForDeployment();
  const otcHubAddress = await otcHub.getAddress();

  console.log("OtcHub deployed to:", otcHubAddress);

  // Deploy MockERC20 for testing (only on local/testnet)
  const network = await ethers.provider.getNetwork();
  if (network.chainId === 31337n || network.chainId === 11155111n) { // localhost or sepolia
    console.log("\nDeploying MockERC20 for testing...");
    const MockERC20 = await ethers.getContractFactory("MockERC20");
    const mockToken = await MockERC20.deploy(
      "Test Token",
      "TEST",
      18,
      ethers.parseUnits("1000000", 18) // 1M tokens
    );

    await mockToken.waitForDeployment();
    const mockTokenAddress = await mockToken.getAddress();

    console.log("MockERC20 deployed to:", mockTokenAddress);

    // Mint some tokens to deployer for testing
    console.log("Minting test tokens to deployer...");
    await mockToken.mint(deployer.address, ethers.parseUnits("10000", 18));
    
    console.log("\nTest token balance of deployer:", 
      ethers.formatUnits(await mockToken.balanceOf(deployer.address), 18), "TEST");
  }

  // Verify deployment
  console.log("\nVerifying deployment...");
  console.log("OtcHub admin:", await otcHub.admin());
  console.log("OtcHub vault:", await otcHub.vault());
  console.log("OtcHub platform fee:", await otcHub.platformFeeBps(), "bps");

  console.log("\n✅ Deployment completed successfully!");
  
  // Save deployment info
  const deploymentInfo = {
    network: network.name,
    chainId: network.chainId.toString(),
    otcHub: otcHubAddress,
    admin: admin,
    vault: vault,
    platformFeeBps: initialFeeBps,
    deployedAt: new Date().toISOString(),
    deployer: deployer.address
  };

  console.log("\nDeployment Summary:");
  console.log(JSON.stringify(deploymentInfo, null, 2));
}

// We recommend this pattern to be able to use async/await everywhere
// and properly handle errors.
main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
