import { expect } from "chai";
import { ethers } from "hardhat";

describe("OtcHub - Admin Dispute Extensions", function () {
  const PLATFORM_FEE_BPS = 50; // 0.5%
  const PRICE = ethers.parseUnits("100", 18);
  const DEPOSIT = ethers.parseUnits("50", 18);
  const FUNDING_WINDOW = 3600;

  async function deployFixture() {
    const [admin, vault, maker, taker, other] = await ethers.getSigners();

    const MockERC20Factory = await ethers.getContractFactory("MockERC20");
    const mockToken = await MockERC20Factory.deploy("Test", "TEST", 18, ethers.parseUnits("1000000", 18));

    const OtcHubFactory = await ethers.getContractFactory("OtcHub");
    const otcHub = await OtcHubFactory.deploy(await admin.getAddress(), await vault.getAddress(), PLATFORM_FEE_BPS);

    // seed balances
    await mockToken.transfer(await maker.getAddress(), ethers.parseUnits("1000", 18));
    await mockToken.transfer(await taker.getAddress(), ethers.parseUnits("1000", 18));

    return { admin, vault, maker, taker, other, mockToken, otcHub };
  }

  async function openAndFundDisputed(otcHub: any, mockToken: any, maker: any, taker: any) {
    const agreementHash = ethers.keccak256(ethers.toUtf8Bytes("agreement"));
    await otcHub.connect(taker).createTrade(
      await maker.getAddress(),
      await mockToken.getAddress(),
      PRICE,
      DEPOSIT,
      FUNDING_WINDOW,
      0,
      agreementHash
    );
    const tradeId = 1;
    await mockToken.connect(maker).approve(await otcHub.getAddress(), DEPOSIT);
    await mockToken.connect(taker).approve(await otcHub.getAddress(), PRICE + DEPOSIT);
    await otcHub.connect(maker).fund(tradeId);
    await otcHub.connect(taker).fund(tradeId);
    await otcHub.connect(maker).raiseDispute(tradeId);
    return tradeId;
  }

  it("adminResolveDispute should award winner all funds minus fee and close trade", async function () {
    const { admin, vault, maker, taker, mockToken, otcHub } = await deployFixture();
    const tradeId = await openAndFundDisputed(otcHub, mockToken, maker, taker);

    const vaultBalBefore = await mockToken.balanceOf(await vault.getAddress());
    const winnerBalBefore = await mockToken.balanceOf(await taker.getAddress());

    const fee = (PRICE * BigInt(PLATFORM_FEE_BPS)) / 10000n;
    const total = PRICE + DEPOSIT * 2n;

    await expect(otcHub.connect(admin).adminResolveDispute(tradeId, await taker.getAddress(), "breach"))
      .to.emit(otcHub, "DisputeResolved");

    const trade = await otcHub.trades(tradeId);
    expect(trade.status).to.equal(5); // AdminClosed

    expect(await mockToken.balanceOf(await vault.getAddress())).to.equal(vaultBalBefore + fee);
    expect(await mockToken.balanceOf(await taker.getAddress())).to.equal(winnerBalBefore + (total - fee));
  });

  it("adminClearDispute should restore to Funded without moving funds", async function () {
    const { admin, vault, maker, taker, mockToken, otcHub } = await deployFixture();
    const tradeId = await openAndFundDisputed(otcHub, mockToken, maker, taker);

    const vaultBalBefore = await mockToken.balanceOf(await vault.getAddress());
    const makerBalBefore = await mockToken.balanceOf(await maker.getAddress());
    const takerBalBefore = await mockToken.balanceOf(await taker.getAddress());

    await expect(otcHub.connect(admin).adminClearDispute(tradeId, "misunderstanding"))
      .to.emit(otcHub, "DisputeCleared");

    const trade = await otcHub.trades(tradeId);
    expect(trade.status).to.equal(1); // Funded

    expect(await mockToken.balanceOf(await vault.getAddress())).to.equal(vaultBalBefore);
    expect(await mockToken.balanceOf(await maker.getAddress())).to.equal(makerBalBefore);
    expect(await mockToken.balanceOf(await taker.getAddress())).to.equal(takerBalBefore);
  });
});



