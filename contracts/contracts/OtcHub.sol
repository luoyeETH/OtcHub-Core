// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IERC20} from "./interfaces/IERC20.sol";

/**
 * @title OtcHub
 * @author 0xluoye
 * @dev An on-chain OTC escrow platform that facilitates secure peer-to-peer trades. 
 * It employs a dual-deposit mechanism where both the maker and the taker lock funds as collateral, 
 * strongly incentivizing trade completion and fair conduct.
 */

contract OtcHub {
    // --- State Variables ---

    address public immutable admin;
    address public vault;
    uint256 public platformFeeBps; // Platform fee in basis points (e.g., 50 is 0.5%)
    uint256 private _tradeCounter;

    // Re-entrancy attack protection
    uint256 private constant _NOT_ENTERED = 1;
    uint256 private constant _ENTERED = 2;
    uint256 private _status;


    // --- Data Structures ---

    enum TradeDirection { MakerSells, MakerBuys }
    
    enum TradeStatus { Open, Funded, Settled, Cancelled, Disputed, AdminClosed }

    struct Trade {
        address maker;
        address taker;
        address depositToken;
        uint256 price;
        uint256 deposit;
        uint256 fundingDeadline;
        TradeDirection direction;
        bytes32 agreementHash;
        TradeStatus status;
        address disputer; // The party who raised the dispute
        bool makerFunded;
        bool takerFunded;
        bool makerConfirmed;
        bool takerConfirmed;
    }

    mapping(uint256 => Trade) public trades;


    // --- Events ---

    event TradeCreated(uint256 indexed tradeId, address indexed maker, address indexed taker, bytes32 agreementHash, uint256 price);
    event TradeFunded(uint256 indexed tradeId, address indexed funder, uint256 amount);
    event TradeConfirmed(uint256 indexed tradeId, address indexed confirmer);
    event TradeSettled(uint256 indexed tradeId, uint256 platformFee);
    event TradeCancelled(uint256 indexed tradeId);
    event TradeDisputed(uint256 indexed tradeId, address indexed disputer);
    event DisputeCancelled(uint256 indexed tradeId, address indexed resolver);
    event RefundClaimed(uint256 indexed tradeId, address indexed claimer, uint256 amount);
    event AdminWithdrawal(uint256 indexed tradeId, address indexed admin, uint256 amount);
    event PlatformFeeUpdated(uint256 newFeeBps);
    event VaultUpdated(address indexed newVault);


    // --- Modifiers ---

    modifier nonReentrant() {
        require(_status != _ENTERED, "ReentrancyGuard: reentrant call");
        _status = _ENTERED;
        _;
        _status = _NOT_ENTERED;
    }

    modifier onlyAdmin() {
        require(msg.sender == admin, "Platform: Caller is not the admin");
        _;
    }

    // --- Functions ---

    constructor(address _admin, address _vault, uint256 _initialFeeBps) {
        require(_admin != address(0), "Admin cannot be zero address");
        require(_vault != address(0), "Vault cannot be zero address");
        admin = _admin;
        vault = _vault;
        platformFeeBps = _initialFeeBps;
        _status = _NOT_ENTERED;
    }

    /**
     * @dev Taker creates a new trade based on the Maker's requirements and direction.
     */
    function createTrade(
        address _maker,
        address _depositToken,
        uint256 _price,
        uint256 _deposit,
        uint256 _fundingWindow,
        TradeDirection _direction,
        bytes32 _agreementHash
    ) external returns (uint256) {
        require(_maker != address(0) && _maker != msg.sender, "Invalid maker");
        require(_depositToken != address(0), "Invalid token");
        require(_price > 0 && _deposit > 0, "Price and deposit must be positive");
        require(_agreementHash != bytes32(0), "Agreement hash cannot be empty");

        uint256 tradeId = ++_tradeCounter;
        trades[tradeId] = Trade({
            maker: _maker,
            taker: msg.sender,
            depositToken: _depositToken,
            price: _price,
            deposit: _deposit,
            fundingDeadline: block.timestamp + _fundingWindow,
            agreementHash: _agreementHash,
            direction: _direction,
            status: TradeStatus.Open,
            disputer: address(0),
            makerFunded: false,
            takerFunded: false,
            makerConfirmed: false,
            takerConfirmed: false
        });

        emit TradeCreated(tradeId, _maker, msg.sender, _agreementHash, _price);
        return tradeId;
    }

    /**
     * @dev Funds a specified trade. Funding requirements are determined dynamically by trade direction.
     */
    function fund(uint256 tradeId) external nonReentrant {
        Trade storage t = trades[tradeId];
        require(t.status == TradeStatus.Open, "Trade not open");
        require(block.timestamp <= t.fundingDeadline, "Funding deadline has passed");
        
        uint256 requiredAmount;
        address pricePayer;
        address depositOnlyPayer;

        // Determine who the price payer is based on the trade direction
        if (t.direction == TradeDirection.MakerSells) {
            pricePayer = t.taker;
            depositOnlyPayer = t.maker;
        } else { // MakerBuys
            pricePayer = t.maker;
            depositOnlyPayer = t.taker;
        }

        if (msg.sender == pricePayer) {
            requiredAmount = t.price + t.deposit;
        } else if (msg.sender == depositOnlyPayer) {
            requiredAmount = t.deposit;
        } else {
            revert("Not a participant");
        }
        
        // --- Effects ---
        if (msg.sender == t.taker) {
            require(!t.takerFunded, "Taker already funded");
            t.takerFunded = true;
        } else { // msg.sender == t.maker
            require(!t.makerFunded, "Maker already funded");
            t.makerFunded = true;
        }

        if (t.takerFunded && t.makerFunded) {
            t.status = TradeStatus.Funded;
        }

        // --- Interactions ---
        IERC20 token = IERC20(t.depositToken);
        require(token.transferFrom(msg.sender, address(this), requiredAmount), "Token transfer failed");

        emit TradeFunded(tradeId, msg.sender, requiredAmount);
    }

    /**
     * @dev Confirms that the trade has been completed off-chain.
     */
    function confirm(uint256 tradeId) external nonReentrant {
        Trade storage t = trades[tradeId];
        require(t.status == TradeStatus.Funded, "Trade not in Funded state");
        
        if (msg.sender == t.taker) {
            require(!t.takerConfirmed, "Taker already confirmed");
            t.takerConfirmed = true;
        } else if (msg.sender == t.maker) {
            require(!t.makerConfirmed, "Maker already confirmed");
            t.makerConfirmed = true;
        } else {
            revert("Not a participant");
        }
        
        emit TradeConfirmed(tradeId, msg.sender);
        
        if (t.takerConfirmed && t.makerConfirmed) {
            _settle(tradeId);
        }
    }
    
    /**
     * @dev Internal function to execute settlement and fund distribution based on trade direction.
     */
    function _settle(uint256 tradeId) internal {
        Trade storage t = trades[tradeId];
        t.status = TradeStatus.Settled;

        uint256 totalDeposited = t.price + (t.deposit * 2);
        uint256 fee = (t.price * platformFeeBps) / 10000;
        
        address priceRecipient;
        address depositRecipient;
        
        // Determine who the price recipient is based on the trade direction
        if (t.direction == TradeDirection.MakerSells) {
            priceRecipient = t.maker;
            depositRecipient = t.taker;
        } else { // MakerBuys
            priceRecipient = t.taker;
            depositRecipient = t.maker;
        }
        
        uint256 priceRecipientPayout = t.price + t.deposit - fee;
        uint256 depositRecipientPayout = t.deposit;

        IERC20 token = IERC20(t.depositToken);
        require(token.balanceOf(address(this)) >= totalDeposited, "Insufficient platform balance");
        
        if (fee > 0) {
            require(token.transfer(treasury, fee), "Fee transfer failed");
        }
        require(token.transfer(priceRecipient, priceRecipientPayout), "Price recipient payout failed");
        require(token.transfer(depositRecipient, depositRecipientPayout), "Deposit recipient payout failed");

        emit TradeSettled(tradeId, fee);
    }
    
    function cancel(uint256 tradeId) external {
        Trade storage t = trades[tradeId];
        require(t.status == TradeStatus.Open, "Trade not open");
        require(block.timestamp > t.fundingDeadline, "Funding deadline not yet passed");
        require(!t.makerFunded || !t.takerFunded, "Cannot cancel a fully funded trade");

        t.status = TradeStatus.Cancelled;
        emit TradeCancelled(tradeId);
    }

    function claimRefund(uint256 tradeId) external nonReentrant {
        Trade storage t = trades[tradeId];
        require(t.status == TradeStatus.Cancelled, "Trade not cancelled");

        uint256 refundAmount;

        if (msg.sender == t.taker && t.takerFunded) {
            // If Taker is the price payer (MakerSells), refund price+deposit, else just deposit
            refundAmount = (t.direction == TradeDirection.MakerSells) ? (t.price + t.deposit) : t.deposit;
            t.takerFunded = false; // Prevent double claim
        } else if (msg.sender == t.maker && t.makerFunded) {
            // If Maker is the price payer (MakerBuys), refund price+deposit, else just deposit
            refundAmount = (t.direction == TradeDirection.MakerBuys) ? (t.price + t.deposit) : t.deposit;
            t.makerFunded = false; // Prevent double claim
        } else {
            revert("No funds to claim");
        }
        
        IERC20 token = IERC20(t.depositToken);
        require(token.transfer(msg.sender, refundAmount), "Refund transfer failed");

        emit RefundClaimed(tradeId, msg.sender, refundAmount);
    }

    /**
     * @dev Allows a trade participant to raise a dispute, pausing the trade.
     */
    function raiseDispute(uint256 tradeId) external {
        Trade storage t = trades[tradeId];
        require(t.status == TradeStatus.Funded, "Trade must be in Funded state to dispute");
        require(msg.sender == t.maker || msg.sender == t.taker, "Only a participant can raise a dispute");
        
        t.status = TradeStatus.Disputed;
        t.disputer = msg.sender;

        emit TradeDisputed(tradeId, msg.sender);
    }

    /**
     * @dev Allows the party who raised a dispute to cancel it, returning the trade to a Funded state.
     */
    function cancelDispute(uint256 tradeId) external {
        Trade storage t = trades[tradeId];
        require(t.status == TradeStatus.Disputed, "Trade is not in dispute");
        require(msg.sender == t.disputer, "Only the original disputer can cancel the dispute");

        t.status = TradeStatus.Funded;
        t.disputer = address(0);

        emit DisputeCancelled(tradeId, msg.sender);
    }
    
    /**
     * @dev Allows the admin to withdraw all funds from a disputed trade for off-chain resolution.
     * This is a fail-safe mechanism that moves the trade to a final AdminClosed state.
     */
    function adminWithdraw(uint256 tradeId) external onlyAdmin nonReentrant {
        Trade storage t = trades[tradeId];
        require(t.status == TradeStatus.Disputed, "Trade must be in a Disputed state for admin withdrawal");
        
        t.status = TradeStatus.AdminClosed;

        uint256 totalAmount = t.price + (t.deposit * 2);
        IERC20 token = IERC20(t.depositToken);

        require(token.balanceOf(address(this)) >= totalAmount, "Insufficient platform balance for withdrawal");
        require(token.transfer(admin, totalAmount), "Admin withdrawal transfer failed");

        emit AdminWithdrawal(tradeId, admin, totalAmount);
    }

    /**
     * @dev Updates the platform fee. Can only be called by the admin.
     * @param _newFeeBps The new fee in basis points.
     */
    function setPlatformFee(uint256 _newFeeBps) external onlyAdmin {
        platformFeeBps = _newFeeBps;
        emit PlatformFeeUpdated(_newFeeBps);
    }

    /**
     * @dev Update the vault address for receiving platform transaction fees.
     * Can only be called by the admin.
     * @param _newVault The new vault address for receiving fees.
     */
    function setVault(address _newVault) external onlyAdmin {
        require(_newVault != address(0), "Vault cannot be zero address");
        vault = _newVault;
        emit VaultUpdated(_newVault);
    }
}