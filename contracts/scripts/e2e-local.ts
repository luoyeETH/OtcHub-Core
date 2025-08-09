import { ethers } from "hardhat";
import fs from "fs";
import path from "path";

async function main() {
  const network = await ethers.provider.getNetwork();
  if (network.chainId !== 31337n) {
    console.log(`This script is intended for localhost (31337). Current: ${network.chainId}`);
  }

  const deploymentsPath = path.join(__dirname, "..", "deployments", "localhost.json");
  if (!fs.existsSync(deploymentsPath)) {
    throw new Error(`Missing deployments file at ${deploymentsPath}. Run: npm run deploy:advanced:local`);
  }
  const deployments = JSON.parse(fs.readFileSync(deploymentsPath, "utf8"));
  const otcHubAddress: string = deployments.contracts.otcHub;
  const mockTokenAddress: string = deployments.contracts.mockToken;

  console.log("Loaded deployments:", { otcHubAddress, mockTokenAddress });

  const [defaultDeployer, vault, maker, taker] = await ethers.getSigners();
  const otcHub = await ethers.getContractAt("OtcHub", otcHubAddress);
  const token = await ethers.getContractAt("MockERC20", mockTokenAddress);

  // Use on-chain admin from deployment (may differ from default deployer in advanced script)
  const onchainAdmin = deployments.config.admin as string;
  // Impersonate admin if it's not the default account
  let adminSigner = defaultDeployer;
  if ((await defaultDeployer.getAddress()).toLowerCase() !== onchainAdmin.toLowerCase()) {
    await ethers.provider.send("hardhat_impersonateAccount", [onchainAdmin]);
    adminSigner = await ethers.getSigner(onchainAdmin);
    // fund impersonated admin with ETH to cover gas
    await (await defaultDeployer.sendTransaction({ to: onchainAdmin, value: ethers.parseEther("1") })).wait();
  }

  // Ensure balances for maker/taker
  await (await token.mint(await maker.getAddress(), ethers.parseUnits("10000", 18))).wait();
  await (await token.mint(await taker.getAddress(), ethers.parseUnits("10000", 18))).wait();

  const PRICE = ethers.parseUnits("100", 18);
  const DEPOSIT = ethers.parseUnits("50", 18);
  const agreement = ethers.keccak256(ethers.toUtf8Bytes("agreement"));

  console.log("Creating trade (MakerSells)...");
  const txCreate = await otcHub.connect(taker).createTrade(
    await maker.getAddress(),
    await token.getAddress(),
    PRICE,
    DEPOSIT,
    3600,
    0,
    agreement
  );
  const rc = await txCreate.wait();
  const created = rc!.logs
    .map((l) => {
      try { return otcHub.interface.parseLog(l); } catch { return null; }
    })
    .find((ev) => ev && ev.name === "TradeCreated");
  if (!created) throw new Error("TradeCreated event not found");
  const tradeId: bigint = created!.args[0] as bigint;
  console.log("Trade ID:", tradeId.toString());

  console.log("Approving and funding...");
  await (await token.connect(maker).approve(await otcHub.getAddress(), DEPOSIT)).wait();
  await (await token.connect(taker).approve(await otcHub.getAddress(), PRICE + DEPOSIT)).wait();
  await (await otcHub.connect(maker).fund(tradeId)).wait();
  await (await otcHub.connect(taker).fund(tradeId)).wait();

  let trade = await otcHub.trades(tradeId);
  console.log("Status after funding:", trade.status.toString()); // expect Funded (1)

  console.log("Raising dispute (by maker)...");
  await (await otcHub.connect(maker).raiseDispute(tradeId)).wait();
  trade = await otcHub.trades(tradeId);
  console.log("Status after dispute:", trade.status.toString()); // expect Disputed (4)

  console.log("Admin resolves dispute awarding to taker...");
  await (await otcHub.connect(adminSigner).adminResolveDispute(tradeId, await taker.getAddress(), "breach")).wait();
  trade = await otcHub.trades(tradeId);
  console.log("Final status:", trade.status.toString()); // expect AdminClosed (5)

  const fee = (PRICE * (await otcHub.platformFeeBps())) / 10000n;
  console.log("Platform fee (wei):", fee.toString());
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});


