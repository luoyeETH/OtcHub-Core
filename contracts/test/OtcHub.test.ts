import { expect } from "chai";
import { ethers } from "hardhat";
import { Signer } from "ethers";
import { OtcHub, MockERC20 } from "../typechain-types";
import { time } from "@nomicfoundation/hardhat-network-helpers";

describe("OtcHub", function () {
  let otcHub: OtcHub;
  let mockToken: MockERC20;
  let admin: Signer;
  let vault: Signer;
  let maker: Signer;
  let taker: Signer;
  let other: Signer;

  let adminAddress: string;
  let vaultAddress: string;
  let makerAddress: string;
  let takerAddress: string;
  let otherAddress: string;

  const PLATFORM_FEE_BPS = 50; // 0.5%
  const PRICE = ethers.parseUnits("100", 18);
  const DEPOSIT = ethers.parseUnits("50", 18);
  const FUNDING_WINDOW = 3600; // 1 hour

  beforeEach(async function () {
    [admin, vault, maker, taker, other] = await ethers.getSigners();
    
    adminAddress = await admin.getAddress();
    vaultAddress = await vault.getAddress();
    makerAddress = await maker.getAddress();
    takerAddress = await taker.getAddress();
    otherAddress = await other.getAddress();

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
    await mockToken.transfer(otherAddress, ethers.parseUnits("1000", 18));
  });

  describe("Deployment", function () {
    it("Should set the correct admin", async function () {
      expect(await otcHub.admin()).to.equal(adminAddress);
    });

    it("Should set the correct vault", async function () {
      expect(await otcHub.vault()).to.equal(vaultAddress);
    });

    it("Should set the correct platform fee", async function () {
      expect(await otcHub.platformFeeBps()).to.equal(PLATFORM_FEE_BPS);
    });

    it("Should revert with zero admin address", async function () {
      const OtcHubFactory = await ethers.getContractFactory("OtcHub");
      await expect(
        OtcHubFactory.deploy(ethers.ZeroAddress, vaultAddress, PLATFORM_FEE_BPS)
      ).to.be.revertedWith("Admin cannot be zero address");
    });

    it("Should revert with zero vault address", async function () {
      const OtcHubFactory = await ethers.getContractFactory("OtcHub");
      await expect(
        OtcHubFactory.deploy(adminAddress, ethers.ZeroAddress, PLATFORM_FEE_BPS)
      ).to.be.revertedWith("Vault cannot be zero address");
    });
  });

  describe("Trade Creation", function () {
    it("Should create a trade successfully", async function () {
      const agreementHash = ethers.keccak256(ethers.toUtf8Bytes("agreement"));
      
      await expect(
        otcHub.connect(taker).createTrade(
          makerAddress,
          await mockToken.getAddress(),
          PRICE,
          DEPOSIT,
          FUNDING_WINDOW,
          0, // MakerSells
          agreementHash
        )
      ).to.emit(otcHub, "TradeCreated")
        .withArgs(1, makerAddress, takerAddress, agreementHash, PRICE);

      const trade = await otcHub.trades(1);
      expect(trade.maker).to.equal(makerAddress);
      expect(trade.taker).to.equal(takerAddress);
      expect(trade.price).to.equal(PRICE);
      expect(trade.deposit).to.equal(DEPOSIT);
      expect(trade.status).to.equal(0); // Open
    });

    it("Should revert with invalid maker", async function () {
      const agreementHash = ethers.keccak256(ethers.toUtf8Bytes("agreement"));
      
      await expect(
        otcHub.connect(taker).createTrade(
          takerAddress, // Same as taker
          await mockToken.getAddress(),
          PRICE,
          DEPOSIT,
          FUNDING_WINDOW,
          0,
          agreementHash
        )
      ).to.be.revertedWith("Invalid maker");
    });

    it("Should revert with zero price", async function () {
      const agreementHash = ethers.keccak256(ethers.toUtf8Bytes("agreement"));
      
      await expect(
        otcHub.connect(taker).createTrade(
          makerAddress,
          await mockToken.getAddress(),
          0, // Zero price
          DEPOSIT,
          FUNDING_WINDOW,
          0,
          agreementHash
        )
      ).to.be.revertedWith("Price and deposit must be positive");
    });
  });

  describe("Create Trade With Fund", function () {
    it("Should create and fund trade in one transaction (MakerSells)", async function () {
      const agreementHash = ethers.keccak256(ethers.toUtf8Bytes("agreement"));
      const totalAmount = PRICE + DEPOSIT; // Taker pays price + deposit in MakerSells

      // Approve tokens first
      await mockToken.connect(taker).approve(await otcHub.getAddress(), totalAmount);

      const takerBalanceBefore = await mockToken.balanceOf(takerAddress);

      await expect(
        otcHub.connect(taker).createTradeWithFund(
          makerAddress,
          await mockToken.getAddress(),
          PRICE,
          DEPOSIT,
          FUNDING_WINDOW,
          0, // MakerSells
          agreementHash
        )
      ).to.emit(otcHub, "TradeCreated")
        .withArgs(1, makerAddress, takerAddress, agreementHash, PRICE)
        .and.to.emit(otcHub, "TradeFunded")
        .withArgs(1, takerAddress, totalAmount);

      const trade = await otcHub.trades(1);
      expect(trade.maker).to.equal(makerAddress);
      expect(trade.taker).to.equal(takerAddress);
      expect(trade.takerFunded).to.be.true;
      expect(trade.makerFunded).to.be.false;
      expect(trade.status).to.equal(0); // Still Open until maker funds

      // Check token transfer
      expect(await mockToken.balanceOf(takerAddress)).to.equal(takerBalanceBefore - totalAmount);
    });

    it("Should create and fund trade in one transaction (MakerBuys)", async function () {
      const agreementHash = ethers.keccak256(ethers.toUtf8Bytes("agreement"));
      const depositAmount = DEPOSIT; // Taker pays only deposit in MakerBuys

      // Approve tokens first
      await mockToken.connect(taker).approve(await otcHub.getAddress(), depositAmount);

      const takerBalanceBefore = await mockToken.balanceOf(takerAddress);

      await expect(
        otcHub.connect(taker).createTradeWithFund(
          makerAddress,
          await mockToken.getAddress(),
          PRICE,
          DEPOSIT,
          FUNDING_WINDOW,
          1, // MakerBuys
          agreementHash
        )
      ).to.emit(otcHub, "TradeCreated")
        .withArgs(1, makerAddress, takerAddress, agreementHash, PRICE)
        .and.to.emit(otcHub, "TradeFunded")
        .withArgs(1, takerAddress, depositAmount);

      const trade = await otcHub.trades(1);
      expect(trade.takerFunded).to.be.true;
      expect(trade.makerFunded).to.be.false;
      expect(trade.status).to.equal(0); // Still Open until maker funds

      // Check token transfer
      expect(await mockToken.balanceOf(takerAddress)).to.equal(takerBalanceBefore - depositAmount);
    });

    it("Should revert if insufficient allowance", async function () {
      const agreementHash = ethers.keccak256(ethers.toUtf8Bytes("agreement"));
      const totalAmount = PRICE + DEPOSIT;

      // Approve less than required
      await mockToken.connect(taker).approve(await otcHub.getAddress(), totalAmount - 1n);

      await expect(
        otcHub.connect(taker).createTradeWithFund(
          makerAddress,
          await mockToken.getAddress(),
          PRICE,
          DEPOSIT,
          FUNDING_WINDOW,
          0, // MakerSells
          agreementHash
        )
      ).to.be.revertedWith("Insufficient token allowance");
    });

    it("Should revert if insufficient balance", async function () {
      const agreementHash = ethers.keccak256(ethers.toUtf8Bytes("agreement"));
      const totalAmount = PRICE + DEPOSIT;

      // Transfer away most tokens to create insufficient balance
      const currentBalance = await mockToken.balanceOf(takerAddress);
      await mockToken.connect(taker).transfer(otherAddress, currentBalance - totalAmount + 1n);

      // Approve sufficient amount
      await mockToken.connect(taker).approve(await otcHub.getAddress(), totalAmount);

      await expect(
        otcHub.connect(taker).createTradeWithFund(
          makerAddress,
          await mockToken.getAddress(),
          PRICE,
          DEPOSIT,
          FUNDING_WINDOW,
          0, // MakerSells
          agreementHash
        )
      ).to.be.revertedWith("ERC20: transfer amount exceeds balance");
    });

    it("Should revert with invalid parameters", async function () {
      const agreementHash = ethers.keccak256(ethers.toUtf8Bytes("agreement"));

      // Test zero maker address
      await expect(
        otcHub.connect(taker).createTradeWithFund(
          ethers.ZeroAddress,
          await mockToken.getAddress(),
          PRICE,
          DEPOSIT,
          FUNDING_WINDOW,
          0,
          agreementHash
        )
      ).to.be.revertedWith("Invalid maker");

      // Test maker same as taker
      await expect(
        otcHub.connect(taker).createTradeWithFund(
          takerAddress,
          await mockToken.getAddress(),
          PRICE,
          DEPOSIT,
          FUNDING_WINDOW,
          0,
          agreementHash
        )
      ).to.be.revertedWith("Invalid maker");
    });
  });

  describe("Trade Funding", function () {
    let tradeId: number;
    let agreementHash: string;

    beforeEach(async function () {
      agreementHash = ethers.keccak256(ethers.toUtf8Bytes("agreement"));
      
      const tx = await otcHub.connect(taker).createTrade(
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

    it("Should allow maker to fund (MakerSells scenario)", async function () {
      // Maker only needs to deposit collateral
      await mockToken.connect(maker).approve(await otcHub.getAddress(), DEPOSIT);
      
      await expect(otcHub.connect(maker).fund(tradeId))
        .to.emit(otcHub, "TradeFunded")
        .withArgs(tradeId, makerAddress, DEPOSIT);

      const trade = await otcHub.trades(tradeId);
      expect(trade.makerFunded).to.be.true;
      expect(trade.status).to.equal(0); // Still Open until both fund
    });

    it("Should allow taker to fund (MakerSells scenario)", async function () {
      // Taker needs to pay price + deposit
      const totalAmount = PRICE + DEPOSIT;
      await mockToken.connect(taker).approve(await otcHub.getAddress(), totalAmount);
      
      await expect(otcHub.connect(taker).fund(tradeId))
        .to.emit(otcHub, "TradeFunded")
        .withArgs(tradeId, takerAddress, totalAmount);

      const trade = await otcHub.trades(tradeId);
      expect(trade.takerFunded).to.be.true;
    });

    it("Should change status to Funded when both parties fund", async function () {
      // Fund both parties
      await mockToken.connect(maker).approve(await otcHub.getAddress(), DEPOSIT);
      await mockToken.connect(taker).approve(await otcHub.getAddress(), PRICE + DEPOSIT);
      
      await otcHub.connect(maker).fund(tradeId);
      await otcHub.connect(taker).fund(tradeId);

      const trade = await otcHub.trades(tradeId);
      expect(trade.status).to.equal(1); // Funded
      expect(trade.makerFunded).to.be.true;
      expect(trade.takerFunded).to.be.true;
    });

    it("Should revert if funding deadline passed", async function () {
      // Fast forward past deadline
      await time.increase(FUNDING_WINDOW + 1);
      
      await mockToken.connect(maker).approve(await otcHub.getAddress(), DEPOSIT);
      
      await expect(otcHub.connect(maker).fund(tradeId))
        .to.be.revertedWith("Funding deadline has passed");
    });

    it("Should revert if non-participant tries to fund", async function () {
      await mockToken.connect(other).approve(await otcHub.getAddress(), DEPOSIT);
      
      await expect(otcHub.connect(other).fund(tradeId))
        .to.be.revertedWith("Not a participant");
    });
  });

  describe("Trade Confirmation and Settlement", function () {
    let tradeId: number;

    beforeEach(async function () {
      const agreementHash = ethers.keccak256(ethers.toUtf8Bytes("agreement"));

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

      // Fund the trade
      await mockToken.connect(maker).approve(await otcHub.getAddress(), DEPOSIT);
      await mockToken.connect(taker).approve(await otcHub.getAddress(), PRICE + DEPOSIT);

      await otcHub.connect(maker).fund(tradeId);
      await otcHub.connect(taker).fund(tradeId);
    });

    it("Should allow participants to confirm", async function () {
      await expect(otcHub.connect(maker).confirm(tradeId))
        .to.emit(otcHub, "TradeConfirmed")
        .withArgs(tradeId, makerAddress);

      const trade = await otcHub.trades(tradeId);
      expect(trade.makerConfirmed).to.be.true;
    });

    it("Should settle trade when both parties confirm", async function () {
      const vaultBalanceBefore = await mockToken.balanceOf(vaultAddress);
      const makerBalanceBefore = await mockToken.balanceOf(makerAddress);
      const takerBalanceBefore = await mockToken.balanceOf(takerAddress);

      await otcHub.connect(maker).confirm(tradeId);

      await expect(otcHub.connect(taker).confirm(tradeId))
        .to.emit(otcHub, "TradeSettled");

      const trade = await otcHub.trades(tradeId);
      expect(trade.status).to.equal(2); // Settled

      // Check balances after settlement
      const fee = (PRICE * BigInt(PLATFORM_FEE_BPS)) / 10000n;
      const expectedMakerPayout = PRICE + DEPOSIT - fee;
      const expectedTakerPayout = DEPOSIT;

      expect(await mockToken.balanceOf(vaultAddress)).to.equal(vaultBalanceBefore + fee);
      expect(await mockToken.balanceOf(makerAddress)).to.equal(makerBalanceBefore + expectedMakerPayout);
      expect(await mockToken.balanceOf(takerAddress)).to.equal(takerBalanceBefore + expectedTakerPayout);
    });

    it("Should revert if non-participant tries to confirm", async function () {
      await expect(otcHub.connect(other).confirm(tradeId))
        .to.be.revertedWith("Not a participant");
    });

    it("Should revert if trying to confirm twice", async function () {
      await otcHub.connect(maker).confirm(tradeId);

      await expect(otcHub.connect(maker).confirm(tradeId))
        .to.be.revertedWith("Maker already confirmed");
    });
  });

  describe("Trade Cancellation and Refunds", function () {
    let tradeId: number;

    beforeEach(async function () {
      const agreementHash = ethers.keccak256(ethers.toUtf8Bytes("agreement"));

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

    it("Should allow cancellation after funding deadline", async function () {
      // Partially fund the trade
      await mockToken.connect(maker).approve(await otcHub.getAddress(), DEPOSIT);
      await otcHub.connect(maker).fund(tradeId);

      // Fast forward past deadline
      await time.increase(FUNDING_WINDOW + 1);

      await expect(otcHub.cancel(tradeId))
        .to.emit(otcHub, "TradeCancelled")
        .withArgs(tradeId);

      const trade = await otcHub.trades(tradeId);
      expect(trade.status).to.equal(3); // Cancelled
    });

    it("Should allow refund claim after cancellation", async function () {
      // Fund maker only
      await mockToken.connect(maker).approve(await otcHub.getAddress(), DEPOSIT);
      await otcHub.connect(maker).fund(tradeId);

      const makerBalanceBefore = await mockToken.balanceOf(makerAddress);

      // Cancel after deadline
      await time.increase(FUNDING_WINDOW + 1);
      await otcHub.cancel(tradeId);

      // Claim refund
      await expect(otcHub.connect(maker).claimRefund(tradeId))
        .to.emit(otcHub, "RefundClaimed")
        .withArgs(tradeId, makerAddress, DEPOSIT);

      expect(await mockToken.balanceOf(makerAddress)).to.equal(makerBalanceBefore + DEPOSIT);
    });

    it("Should revert cancellation before deadline", async function () {
      await expect(otcHub.cancel(tradeId))
        .to.be.revertedWith("Funding deadline not yet passed");
    });

    it("Should revert cancellation of fully funded trade", async function () {
      // Fund both parties
      await mockToken.connect(maker).approve(await otcHub.getAddress(), DEPOSIT);
      await mockToken.connect(taker).approve(await otcHub.getAddress(), PRICE + DEPOSIT);

      await otcHub.connect(maker).fund(tradeId);
      await otcHub.connect(taker).fund(tradeId);

      // Try to cancel after deadline - should fail because trade is not in Open status
      await time.increase(FUNDING_WINDOW + 1);

      await expect(otcHub.cancel(tradeId))
        .to.be.revertedWith("Trade not open");
    });
  });

  describe("Dispute Handling", function () {
    let tradeId: number;

    beforeEach(async function () {
      const agreementHash = ethers.keccak256(ethers.toUtf8Bytes("agreement"));

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

      // Fund the trade
      await mockToken.connect(maker).approve(await otcHub.getAddress(), DEPOSIT);
      await mockToken.connect(taker).approve(await otcHub.getAddress(), PRICE + DEPOSIT);

      await otcHub.connect(maker).fund(tradeId);
      await otcHub.connect(taker).fund(tradeId);
    });

    it("Should allow participants to raise dispute", async function () {
      await expect(otcHub.connect(maker).raiseDispute(tradeId))
        .to.emit(otcHub, "TradeDisputed")
        .withArgs(tradeId, makerAddress);

      const trade = await otcHub.trades(tradeId);
      expect(trade.status).to.equal(4); // Disputed
      expect(trade.disputer).to.equal(makerAddress);
    });

    it("Should allow disputer to cancel dispute", async function () {
      await otcHub.connect(maker).raiseDispute(tradeId);

      await expect(otcHub.connect(maker).cancelDispute(tradeId))
        .to.emit(otcHub, "DisputeCancelled")
        .withArgs(tradeId, makerAddress);

      const trade = await otcHub.trades(tradeId);
      expect(trade.status).to.equal(1); // Back to Funded
      expect(trade.disputer).to.equal(ethers.ZeroAddress);
    });

    it("Should allow admin to withdraw disputed funds", async function () {
      await otcHub.connect(maker).raiseDispute(tradeId);

      const adminBalanceBefore = await mockToken.balanceOf(adminAddress);
      const totalAmount = PRICE + (DEPOSIT * 2n);

      await expect(otcHub.connect(admin).adminWithdraw(tradeId))
        .to.emit(otcHub, "AdminWithdrawal")
        .withArgs(tradeId, adminAddress, totalAmount);

      const trade = await otcHub.trades(tradeId);
      expect(trade.status).to.equal(5); // AdminClosed
      expect(await mockToken.balanceOf(adminAddress)).to.equal(adminBalanceBefore + totalAmount);
    });

    it("Should revert dispute from non-participant", async function () {
      await expect(otcHub.connect(other).raiseDispute(tradeId))
        .to.be.revertedWith("Only a participant can raise a dispute");
    });

    it("Should revert dispute cancellation from non-disputer", async function () {
      await otcHub.connect(maker).raiseDispute(tradeId);

      await expect(otcHub.connect(taker).cancelDispute(tradeId))
        .to.be.revertedWith("Only the original disputer can cancel the dispute");
    });
  });

  describe("Admin Functions", function () {
    it("Should allow admin to update platform fee", async function () {
      const newFee = 100; // 1%

      await expect(otcHub.connect(admin).setPlatformFee(newFee))
        .to.emit(otcHub, "PlatformFeeUpdated")
        .withArgs(newFee);

      expect(await otcHub.platformFeeBps()).to.equal(newFee);
    });

    it("Should allow admin to update vault", async function () {
      const newVault = await other.getAddress();

      await expect(otcHub.connect(admin).setVault(newVault))
        .to.emit(otcHub, "VaultUpdated")
        .withArgs(newVault);

      expect(await otcHub.vault()).to.equal(newVault);
    });

    it("Should revert non-admin fee update", async function () {
      await expect(otcHub.connect(maker).setPlatformFee(100))
        .to.be.revertedWith("Platform: Caller is not the admin");
    });

    it("Should revert vault update to zero address", async function () {
      await expect(otcHub.connect(admin).setVault(ethers.ZeroAddress))
        .to.be.revertedWith("Vault cannot be zero address");
    });
  });
});
