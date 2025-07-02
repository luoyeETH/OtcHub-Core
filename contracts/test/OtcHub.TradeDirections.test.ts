import { expect } from "chai";
import { ethers } from "hardhat";
import { Signer } from "ethers";
import { OtcHub, MockERC20 } from "../typechain-types";

describe("OtcHub - Trade Directions", function () {
  let otcHub: OtcHub;
  let mockToken: MockERC20;
  let admin: Signer;
  let vault: Signer;
  let maker: Signer;
  let taker: Signer;

  let adminAddress: string;
  let vaultAddress: string;
  let makerAddress: string;
  let takerAddress: string;

  const PLATFORM_FEE_BPS = 50; // 0.5%
  const PRICE = ethers.parseUnits("100", 18);
  const DEPOSIT = ethers.parseUnits("50", 18);
  const FUNDING_WINDOW = 3600; // 1 hour

  beforeEach(async function () {
    [admin, vault, maker, taker] = await ethers.getSigners();
    
    adminAddress = await admin.getAddress();
    vaultAddress = await vault.getAddress();
    makerAddress = await maker.getAddress();
    takerAddress = await taker.getAddress();

    // Deploy MockERC20
    const MockERC20Factory = await ethers.getContractFactory("MockERC20");
    mockToken = await MockERC20Factory.deploy(
      "Test Token",
      "TEST",
      18,
      ethers.parseUnits("1000000", 18)
    );

    // Deploy OtcHub
    const OtcHubFactory = await ethers.getContractFactory("OtcHub");
    otcHub = await OtcHubFactory.deploy(adminAddress, vaultAddress, PLATFORM_FEE_BPS);

    // Distribute tokens
    await mockToken.transfer(makerAddress, ethers.parseUnits("1000", 18));
    await mockToken.transfer(takerAddress, ethers.parseUnits("1000", 18));
  });

  describe("MakerSells Direction", function () {
    let tradeId: number;

    beforeEach(async function () {
      const agreementHash = ethers.keccak256(ethers.toUtf8Bytes("maker-sells-agreement"));
      
      await otcHub.connect(taker).createTrade(
        makerAddress,
        await mockToken.getAddress(),
        PRICE,
        DEPOSIT,
        FUNDING_WINDOW,
        0, // MakerSells
        agreementHash
      );
      
      tradeId = 1;
    });

    it("Should require correct funding amounts for MakerSells", async function () {
      // Maker (seller) should only pay deposit
      await mockToken.connect(maker).approve(await otcHub.getAddress(), DEPOSIT);
      await otcHub.connect(maker).fund(tradeId);

      // Taker (buyer) should pay price + deposit
      await mockToken.connect(taker).approve(await otcHub.getAddress(), PRICE + DEPOSIT);
      await otcHub.connect(taker).fund(tradeId);

      const trade = await otcHub.trades(tradeId);
      expect(trade.status).to.equal(1); // Funded
    });

    it("Should distribute funds correctly on settlement for MakerSells", async function () {
      // Fund the trade
      await mockToken.connect(maker).approve(await otcHub.getAddress(), DEPOSIT);
      await mockToken.connect(taker).approve(await otcHub.getAddress(), PRICE + DEPOSIT);
      await otcHub.connect(maker).fund(tradeId);
      await otcHub.connect(taker).fund(tradeId);

      // Record balances before settlement
      const vaultBalanceBefore = await mockToken.balanceOf(vaultAddress);
      const makerBalanceBefore = await mockToken.balanceOf(makerAddress);
      const takerBalanceBefore = await mockToken.balanceOf(takerAddress);

      // Confirm and settle
      await otcHub.connect(maker).confirm(tradeId);
      await otcHub.connect(taker).confirm(tradeId);

      // Calculate expected amounts
      const fee = (PRICE * BigInt(PLATFORM_FEE_BPS)) / 10000n;
      const expectedMakerPayout = PRICE + DEPOSIT - fee; // Maker gets price - fee + deposit back
      const expectedTakerPayout = DEPOSIT; // Taker gets deposit back

      // Verify final balances
      expect(await mockToken.balanceOf(vaultAddress)).to.equal(vaultBalanceBefore + fee);
      expect(await mockToken.balanceOf(makerAddress)).to.equal(makerBalanceBefore + expectedMakerPayout);
      expect(await mockToken.balanceOf(takerAddress)).to.equal(takerBalanceBefore + expectedTakerPayout);
    });

    it("Should handle refunds correctly for MakerSells", async function () {
      // Only maker funds
      await mockToken.connect(maker).approve(await otcHub.getAddress(), DEPOSIT);
      await otcHub.connect(maker).fund(tradeId);

      const makerBalanceBefore = await mockToken.balanceOf(makerAddress);

      // Cancel after deadline
      await ethers.provider.send("evm_increaseTime", [FUNDING_WINDOW + 1]);
      await otcHub.cancel(tradeId);

      // Maker should get back only deposit
      await otcHub.connect(maker).claimRefund(tradeId);
      expect(await mockToken.balanceOf(makerAddress)).to.equal(makerBalanceBefore + DEPOSIT);
    });
  });

  describe("MakerBuys Direction", function () {
    let tradeId: number;

    beforeEach(async function () {
      const agreementHash = ethers.keccak256(ethers.toUtf8Bytes("maker-buys-agreement"));
      
      await otcHub.connect(taker).createTrade(
        makerAddress,
        await mockToken.getAddress(),
        PRICE,
        DEPOSIT,
        FUNDING_WINDOW,
        1, // MakerBuys
        agreementHash
      );
      
      tradeId = 1;
    });

    it("Should require correct funding amounts for MakerBuys", async function () {
      // Maker (buyer) should pay price + deposit
      await mockToken.connect(maker).approve(await otcHub.getAddress(), PRICE + DEPOSIT);
      await otcHub.connect(maker).fund(tradeId);

      // Taker (seller) should only pay deposit
      await mockToken.connect(taker).approve(await otcHub.getAddress(), DEPOSIT);
      await otcHub.connect(taker).fund(tradeId);

      const trade = await otcHub.trades(tradeId);
      expect(trade.status).to.equal(1); // Funded
    });

    it("Should distribute funds correctly on settlement for MakerBuys", async function () {
      // Fund the trade
      await mockToken.connect(maker).approve(await otcHub.getAddress(), PRICE + DEPOSIT);
      await mockToken.connect(taker).approve(await otcHub.getAddress(), DEPOSIT);
      await otcHub.connect(maker).fund(tradeId);
      await otcHub.connect(taker).fund(tradeId);

      // Record balances before settlement
      const vaultBalanceBefore = await mockToken.balanceOf(vaultAddress);
      const makerBalanceBefore = await mockToken.balanceOf(makerAddress);
      const takerBalanceBefore = await mockToken.balanceOf(takerAddress);

      // Confirm and settle
      await otcHub.connect(maker).confirm(tradeId);
      await otcHub.connect(taker).confirm(tradeId);

      // Calculate expected amounts
      const fee = (PRICE * BigInt(PLATFORM_FEE_BPS)) / 10000n;
      const expectedMakerPayout = DEPOSIT; // Maker gets deposit back
      const expectedTakerPayout = PRICE + DEPOSIT - fee; // Taker gets price - fee + deposit back

      // Verify final balances
      expect(await mockToken.balanceOf(vaultAddress)).to.equal(vaultBalanceBefore + fee);
      expect(await mockToken.balanceOf(makerAddress)).to.equal(makerBalanceBefore + expectedMakerPayout);
      expect(await mockToken.balanceOf(takerAddress)).to.equal(takerBalanceBefore + expectedTakerPayout);
    });

    it("Should handle refunds correctly for MakerBuys", async function () {
      // Only taker funds
      await mockToken.connect(taker).approve(await otcHub.getAddress(), DEPOSIT);
      await otcHub.connect(taker).fund(tradeId);

      const takerBalanceBefore = await mockToken.balanceOf(takerAddress);

      // Cancel after deadline
      await ethers.provider.send("evm_increaseTime", [FUNDING_WINDOW + 1]);
      await otcHub.cancel(tradeId);

      // Taker should get back only deposit
      await otcHub.connect(taker).claimRefund(tradeId);
      expect(await mockToken.balanceOf(takerAddress)).to.equal(takerBalanceBefore + DEPOSIT);
    });

    it("Should handle maker refund correctly for MakerBuys", async function () {
      // Only maker funds (price + deposit)
      await mockToken.connect(maker).approve(await otcHub.getAddress(), PRICE + DEPOSIT);
      await otcHub.connect(maker).fund(tradeId);

      const makerBalanceBefore = await mockToken.balanceOf(makerAddress);

      // Cancel after deadline
      await ethers.provider.send("evm_increaseTime", [FUNDING_WINDOW + 1]);
      await otcHub.cancel(tradeId);

      // Maker should get back price + deposit
      await otcHub.connect(maker).claimRefund(tradeId);
      expect(await mockToken.balanceOf(makerAddress)).to.equal(makerBalanceBefore + PRICE + DEPOSIT);
    });
  });

  describe("Edge Cases", function () {
    it("Should handle zero platform fee correctly", async function () {
      // Deploy with zero fee
      const OtcHubFactory = await ethers.getContractFactory("OtcHub");
      const zeroFeeHub = await OtcHubFactory.deploy(adminAddress, vaultAddress, 0);

      const agreementHash = ethers.keccak256(ethers.toUtf8Bytes("zero-fee-agreement"));
      
      await zeroFeeHub.connect(taker).createTrade(
        makerAddress,
        await mockToken.getAddress(),
        PRICE,
        DEPOSIT,
        FUNDING_WINDOW,
        0, // MakerSells
        agreementHash
      );

      // Fund and settle
      await mockToken.connect(maker).approve(await zeroFeeHub.getAddress(), DEPOSIT);
      await mockToken.connect(taker).approve(await zeroFeeHub.getAddress(), PRICE + DEPOSIT);
      await zeroFeeHub.connect(maker).fund(1);
      await zeroFeeHub.connect(taker).fund(1);

      const vaultBalanceBefore = await mockToken.balanceOf(vaultAddress);
      const makerBalanceBefore = await mockToken.balanceOf(makerAddress);

      await zeroFeeHub.connect(maker).confirm(1);
      await zeroFeeHub.connect(taker).confirm(1);

      // No fee should be charged
      expect(await mockToken.balanceOf(vaultAddress)).to.equal(vaultBalanceBefore);
      expect(await mockToken.balanceOf(makerAddress)).to.equal(makerBalanceBefore + PRICE + DEPOSIT);
    });
  });
});
