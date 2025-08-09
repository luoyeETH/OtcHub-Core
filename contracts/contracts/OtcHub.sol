// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/**
 * @title OtcHub
 * @author 0xluoye
 * @dev An on-chain OTC escrow platform that facilitates secure peer-to-peer trades. 
 * It employs a dual-deposit mechanism where both the maker and the taker lock funds as collateral, 
 * strongly incentivizing trade completion and fair conduct.
 */

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";

import "@openzeppelin/contracts/utils/cryptography/ECDSA.sol";
import "@openzeppelin/contracts/utils/cryptography/EIP712.sol";
import "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";

interface IERC20Permit {
    function permit(
        address owner,
        address spender,
        uint256 value,
        uint256 deadline,
        uint8 v, bytes32 r, bytes32 s
    ) external;
}

contract OtcHub is EIP712 {
    using SafeERC20 for IERC20;
    using ECDSA for bytes32;

    address public immutable admin;
    address public vault;
    uint256 public platformFeeBps; // Platform fee in basis points (e.g., 50 is 0.5%)
    uint256 private _tradeCounter;

    // Re-entrancy attack protection
    uint256 private constant _NOT_ENTERED = 1;
    uint256 private constant _ENTERED = 2;
    uint256 private _status;
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
        address disputer;
        bool makerFunded;
        bool takerFunded;
        bool makerConfirmed;
        bool takerConfirmed;
    }

    mapping(uint256 => Trade) public trades;
    event TradeCreated(uint256 indexed tradeId, address indexed maker, address indexed taker, bytes32 agreementHash, uint256 price);
    event TradeFunded(uint256 indexed tradeId, address indexed funder, uint256 amount);
    event TradeConfirmed(uint256 indexed tradeId, address indexed confirmer);
    event TradeSettled(uint256 indexed tradeId, uint256 platformFee);
    event TradeCancelled(uint256 indexed tradeId);
    event TradeDisputed(uint256 indexed tradeId, address indexed disputer);
    event DisputeCancelled(uint256 indexed tradeId, address indexed resolver);
    event RefundClaimed(uint256 indexed tradeId, address indexed claimer, uint256 amount);
    event AdminWithdrawal(uint256 indexed tradeId, address indexed admin, uint256 amount);
    event DisputeResolved(uint256 indexed tradeId, address indexed winner, address indexed loser, uint256 platformFee, string reason);
    event DisputeCleared(uint256 indexed tradeId, address indexed admin, string reason);
    event PlatformFeeUpdated(uint256 newFeeBps);
    event VaultUpdated(address indexed newVault);
    event OrderPartiallyFilled(bytes32 indexed orderHash, address indexed taker, uint256 fillAmount, uint256 remainingAmount);
    event OrderFullyFilled(bytes32 indexed orderHash, address indexed lastTaker);
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

    bytes32 public constant SELLORDER_TYPEHASH = keccak256(
        "SellOrder(address maker,address depositToken,uint256 unitPrice,uint256 unitDeposit,uint256 totalQuantity,uint256 minFillAmount,uint256 expiry,uint256 nonce,address allowedBuyer,uint8 direction,bytes32 agreementHash)"
    );

    // mapping to track filled quantities for each order (orderHash => filledQuantity)
    mapping(bytes32 => uint256) public orderFilled;
    // mapping maker => nonce used / cancelled
    mapping(address => mapping(uint256 => bool)) public nonceUsed;
    constructor(address _admin, address _vault, uint256 _initialFeeBps)
        EIP712("OtcHub", "1")
    {
        require(_admin != address(0), "Admin cannot be zero address");
        require(_vault != address(0), "Vault cannot be zero address");
        admin = _admin;
        vault = _vault;
        platformFeeBps = _initialFeeBps;
        _status = _NOT_ENTERED;
    }

    /**
     * @notice Taker creates a new trade based on the Maker's requirements and direction
     * @param _maker The address of the maker
     * @param _depositToken The token used for deposits and payments
     * @param _price The price for the trade
     * @param _deposit The deposit amount required from each party
     * @param _fundingWindow The time window for funding the trade (in seconds)
     * @param _direction The direction of the trade (MakerSells or MakerBuys)
     * @param _agreementHash Hash of the off-chain agreement
     * @return The ID of the created trade
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
     * @notice Taker creates a new trade and immediately funds it with their required amount
     * @dev This saves the taker one transaction step but requires prior token approval
     * @param _maker The address of the maker
     * @param _depositToken The token used for deposits and payments
     * @param _price The price for the trade
     * @param _deposit The deposit amount required from each party
     * @param _fundingWindow The time window for funding the trade (in seconds)
     * @param _direction The direction of the trade (MakerSells or MakerBuys)
     * @param _agreementHash Hash of the off-chain agreement
     * @return The ID of the created trade
     */
    function createTradeWithFund(
        address _maker,
        address _depositToken,
        uint256 _price,
        uint256 _deposit,
        uint256 _fundingWindow,
        TradeDirection _direction,
        bytes32 _agreementHash
    ) external nonReentrant returns (uint256) {
        require(_maker != address(0) && _maker != msg.sender, "Invalid maker");
        require(_depositToken != address(0), "Invalid token");
        require(_price > 0 && _deposit > 0, "Price and deposit must be positive");
        require(_agreementHash != bytes32(0), "Agreement hash cannot be empty");

        // Calculate required amount for taker based on trade direction
        uint256 requiredAmount;
        if (_direction == TradeDirection.MakerSells) {
            // Taker is the price payer (buyer), needs to pay price + deposit
            requiredAmount = _price + _deposit;
        } else { // MakerBuys
            // Taker is the deposit-only payer (seller), needs to pay only deposit
            requiredAmount = _deposit;
        }

        // Check token allowance before creating trade (skip if no payment required)
        if (requiredAmount > 0) {
            IERC20 token = IERC20(_depositToken);
            require(token.allowance(msg.sender, address(this)) >= requiredAmount, "Insufficient token allowance");
        }

        // First, create the trade (this generates the trade ID)
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
            takerFunded: true, // Taker is immediately funded
            makerConfirmed: false,
            takerConfirmed: false
        });

        // Then, transfer the funds (skip if no payment required)
        if (requiredAmount > 0) {
            IERC20 token = IERC20(_depositToken);
            // use SafeERC20 for safer transferFrom
            token.safeTransferFrom(msg.sender, address(this), requiredAmount);
        }

        emit TradeCreated(tradeId, _maker, msg.sender, _agreementHash, _price);
        emit TradeFunded(tradeId, msg.sender, requiredAmount);

        return tradeId;
    }

    /**
     * @notice Funds a specified trade. Funding requirements are determined dynamically by trade direction
     * @param tradeId The ID of the trade to fund
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
        if (requiredAmount > 0) {
            IERC20 token = IERC20(t.depositToken);
            // use SafeERC20
            token.safeTransferFrom(msg.sender, address(this), requiredAmount);
        }

        emit TradeFunded(tradeId, msg.sender, requiredAmount);
    }

    /**
     * @notice Confirms that the trade has been completed off-chain
     * @param tradeId The ID of the trade to confirm
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
     * @notice Internal function to execute settlement and fund distribution based on trade direction
     * @param tradeId The ID of the trade to settle
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
            token.safeTransfer(vault, fee);
        }
        token.safeTransfer(priceRecipient, priceRecipientPayout);
        token.safeTransfer(depositRecipient, depositRecipientPayout);

        emit TradeSettled(tradeId, fee);
    }
    
    /**
     * @notice Cancels a trade after the funding deadline has passed
     * @param tradeId The ID of the trade to cancel
     */
    function cancel(uint256 tradeId) external {
        Trade storage t = trades[tradeId];
        require(t.status == TradeStatus.Open, "Trade not open");
        require(block.timestamp > t.fundingDeadline, "Funding deadline not yet passed");
        require(!t.makerFunded || !t.takerFunded, "Cannot cancel a fully funded trade");

        t.status = TradeStatus.Cancelled;
        emit TradeCancelled(tradeId);
    }

    /**
     * @notice Claims refund for a cancelled trade
     * @param tradeId The ID of the cancelled trade
     */
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
        token.safeTransfer(msg.sender, refundAmount);

        emit RefundClaimed(tradeId, msg.sender, refundAmount);
    }

    /**
     * @notice Allows a trade participant to raise a dispute, pausing the trade
     * @param tradeId The ID of the trade to dispute
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
     * @notice Allows the party who raised a dispute to cancel it, returning the trade to a Funded state
     * @param tradeId The ID of the disputed trade
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
     * @notice Allows the admin to withdraw all funds from a disputed trade for off-chain resolution
     * @dev This is a fail-safe mechanism that moves the trade to a final AdminClosed state
     * @param tradeId The ID of the disputed trade
     */
    function adminWithdraw(uint256 tradeId) external onlyAdmin nonReentrant {
        Trade storage t = trades[tradeId];
        require(t.status == TradeStatus.Disputed, "Trade must be in a Disputed state for admin withdrawal");
        
        t.status = TradeStatus.AdminClosed;

        uint256 totalAmount = t.price + (t.deposit * 2);
        IERC20 token = IERC20(t.depositToken);

        require(token.balanceOf(address(this)) >= totalAmount, "Insufficient platform balance for withdrawal");
        token.safeTransfer(admin, totalAmount);

        emit AdminWithdrawal(tradeId, admin, totalAmount);
    }

    /**
     * @notice Admin resolves a dispute by awarding all escrowed funds (minus platform fee) to the winner
     * @dev Transfers fee to vault and the remainder to winner, then closes the trade
     * @param tradeId The disputed trade id
     * @param winner The address adjudicated as the non-breaching party (must be maker or taker)
     * @param reason A short reason string recorded on-chain
     */
    function adminResolveDispute(
        uint256 tradeId,
        address winner,
        string calldata reason
    ) external onlyAdmin nonReentrant {
        Trade storage t = trades[tradeId];
        require(t.status == TradeStatus.Disputed, "Trade is not disputed");
        require(winner == t.maker || winner == t.taker, "Winner must be maker or taker");

        // finalize state first
        t.status = TradeStatus.AdminClosed;
        address loser = (winner == t.maker) ? t.taker : t.maker;
        t.disputer = address(0);

        uint256 totalDeposited = t.price + (t.deposit * 2);
        uint256 fee = (t.price * platformFeeBps) / 10000;

        IERC20 token = IERC20(t.depositToken);
        require(token.balanceOf(address(this)) >= totalDeposited, "Insufficient platform balance");

        if (fee > 0) {
            token.safeTransfer(vault, fee);
        }
        token.safeTransfer(winner, totalDeposited - fee);

        emit DisputeResolved(tradeId, winner, loser, fee, reason);
    }

    /**
     * @notice Admin clears a dispute and restores the trade to Funded state so parties can proceed normally
     * @dev Ensures escrowed funds remain intact
     * @param tradeId The disputed trade id
     * @param reason A short reason string recorded on-chain
     */
    function adminClearDispute(
        uint256 tradeId,
        string calldata reason
    ) external onlyAdmin {
        Trade storage t = trades[tradeId];
        require(t.status == TradeStatus.Disputed, "Trade is not disputed");

        // sanity: ensure escrow intact
        uint256 totalDeposited = t.price + (t.deposit * 2);
        IERC20 token = IERC20(t.depositToken);
        require(token.balanceOf(address(this)) >= totalDeposited, "Escrow not intact");

        t.status = TradeStatus.Funded;
        t.disputer = address(0);

        emit DisputeCleared(tradeId, msg.sender, reason);
    }

    /**
     * @notice Updates the platform fee. Can only be called by the admin
     * @param _newFeeBps The new fee in basis points
     */
    function setPlatformFee(uint256 _newFeeBps) external onlyAdmin {
        require(_newFeeBps <= 500, "Fee cannot exceed 5%");
        platformFeeBps = _newFeeBps;
        emit PlatformFeeUpdated(_newFeeBps);
    }

    /**
     * @notice Update the vault address for receiving platform transaction fees
     * @dev Can only be called by the admin
     * @param _newVault The new vault address for receiving fees
     */
    function setVault(address _newVault) external onlyAdmin {
        require(_newVault != address(0), "Vault cannot be zero address");
        vault = _newVault;
        emit VaultUpdated(_newVault);
    }

    struct SellOrder {
        address maker;
        address depositToken;
        uint256 unitPrice;        // Price per unit
        uint256 unitDeposit;      // Deposit per unit  
        uint256 totalQuantity;    // Total quantity available
        uint256 minFillAmount;    // Minimum fill amount per transaction
        uint256 expiry;
        uint256 nonce;
        address allowedBuyer;
        TradeDirection direction;
        bytes32 agreementHash;
    }

    /**
     * @notice Maker can cancel a nonce on-chain to invalidate any signed order using that nonce
     * @dev This mirrors the nonceUsed mapping to prevent replay
     * @param nonce The nonce to cancel
     */
    function cancelSignedOrder(uint256 nonce) external {
        require(!nonceUsed[msg.sender][nonce], "Nonce already used/cancelled");
        nonceUsed[msg.sender][nonce] = true;
    }

    /**
     * @notice Buyer supplies a signed SellOrder (from maker) and fill amount
     * @dev Contract verifies EIP-712 signature, supports partial fills with quantity tracking,
     *      optional permit for maker, pulls required maker funds and buyer funds atomically, then creates a Funded Trade
     * @param order The struct that maker signed off-chain
     * @param fillAmount The amount buyer wants to fill (must be >= minFillAmount and <= remaining)
     * @param signature The maker signature for the order (EIP-712)
     * @param permitData Optional abi-encoded permit parameters:
     *        abi.encode(uint256 value, uint256 deadline, uint8 v, bytes32 r, bytes32 s)
     *        If provided, contract will call IERC20Permit(order.depositToken).permit(maker, address(this), value, deadline, v, r, s)
     * @return The ID of the created trade
     */
    function fillSignedOrder(
        SellOrder calldata order,
        uint256 fillAmount,
        bytes calldata signature,
        bytes calldata permitData
    ) external nonReentrant returns (uint256) {
        // 1) basic checks
        require(order.expiry == 0 || block.timestamp < order.expiry, "Order expired");
        require(!(order.allowedBuyer != address(0) && order.allowedBuyer != msg.sender), "Not allowed buyer");
        require(!nonceUsed[order.maker][order.nonce], "Nonce used/cancelled");

        // 2) reconstruct EIP-712 digest and recover signer
        bytes32 structHash = keccak256(
            abi.encode(
                SELLORDER_TYPEHASH,
                order.maker,
                order.depositToken,
                order.unitPrice,
                order.unitDeposit,
                order.totalQuantity,
                order.minFillAmount,
                order.expiry,
                order.nonce,
                order.allowedBuyer,
                uint8(order.direction),
                order.agreementHash
            )
        );
        bytes32 digest = _hashTypedDataV4(structHash);
        address signer = ECDSA.recover(digest, signature);
        require(signer == order.maker, "Invalid maker signature");

        // 3) Check partial fill constraints and calculate remaining quantity
        uint256 alreadyFilled = orderFilled[digest];
        uint256 remainingQuantity = order.totalQuantity - alreadyFilled;
        
        require(remainingQuantity > 0, "Order fully filled");
        require(fillAmount > 0, "Fill amount must be positive");
        require(fillAmount >= order.minFillAmount, "Fill amount below minimum");
        require(fillAmount <= remainingQuantity, "Fill amount exceeds remaining");

        IERC20 token = IERC20(order.depositToken);

        // 3) optional permit: decode and call permit if provided
        if (permitData.length > 0) {
            // expected encoding: (uint256 value, uint256 deadline, uint8 v, bytes32 r, bytes32 s)
            // decode; if decode fails it will revert
            (uint256 value, uint256 deadline, uint8 v, bytes32 r, bytes32 s) = abi.decode(permitData, (uint256, uint256, uint8, bytes32, bytes32));
            // call permit on token with error handling
            try IERC20Permit(order.depositToken).permit(order.maker, address(this), value, deadline, v, r, s) {
                // permit succeeded, continue
            } catch {
                // permit failed, but continue execution
                // this allows for cases where permit was already called or token doesn't support permit
            }
        }

        // 4) calculate required amounts based on fillAmount and unit prices
        uint256 totalPrice = order.unitPrice * fillAmount;
        uint256 totalDeposit = order.unitDeposit * fillAmount;
        uint256 requiredMakerAmount;
        uint256 requiredBuyerAmount;

        if (order.direction == TradeDirection.MakerSells) {
            // Maker sells -> maker pays deposit; buyer pays price + deposit
            requiredMakerAmount = totalDeposit;
            requiredBuyerAmount = totalPrice + totalDeposit;
        } else {
            // MakerBuys -> maker pays price + deposit; buyer (taker) pays deposit
            requiredMakerAmount = totalPrice + totalDeposit;
            requiredBuyerAmount = totalDeposit;
        }

        // 5) Pull maker funds (maker must have given allowance or permit was used)
        if (requiredMakerAmount > 0) {
            token.safeTransferFrom(order.maker, address(this), requiredMakerAmount);
        }

        // 6) Pull buyer funds (msg.sender)
        if (requiredBuyerAmount > 0) {
            token.safeTransferFrom(msg.sender, address(this), requiredBuyerAmount);
        }

        // 7) Update filled quantity and emit events
        orderFilled[digest] = alreadyFilled + fillAmount;
        uint256 newRemainingQuantity = order.totalQuantity - orderFilled[digest];
        
        if (newRemainingQuantity == 0) {
            emit OrderFullyFilled(digest, msg.sender);
            // Mark nonce as used when order is fully filled
            nonceUsed[order.maker][order.nonce] = true;
        } else {
            emit OrderPartiallyFilled(digest, msg.sender, fillAmount, newRemainingQuantity);
        }

        // 8) Create a Trade record in Funded state (reusing existing storage layout)
        uint256 tradeId = ++_tradeCounter;
        trades[tradeId] = Trade({
            maker: order.maker,
            taker: msg.sender,
            depositToken: order.depositToken,
            price: totalPrice,
            deposit: totalDeposit,
            fundingDeadline: block.timestamp, // already funded
            agreementHash: order.agreementHash,
            direction: order.direction,
            status: TradeStatus.Funded,
            disputer: address(0),
            makerFunded: true,
            takerFunded: true,
            makerConfirmed: false,
            takerConfirmed: false
        });

        emit TradeCreated(tradeId, order.maker, msg.sender, order.agreementHash, totalPrice);
        emit TradeFunded(tradeId, order.maker, requiredMakerAmount);
        emit TradeFunded(tradeId, msg.sender, requiredBuyerAmount);

        return tradeId;
    }

    /**
     * @notice Get remaining quantity for a signed order
     * @param order The order struct
     * @param signature The maker signature for the order
     * @return remainingQuantity The remaining unfilled quantity
     */
    function getRemainingQuantity(
        SellOrder calldata order,
        bytes calldata signature
    ) external view returns (uint256 remainingQuantity) {
        // Reconstruct digest to get orderHash
        bytes32 structHash = keccak256(
            abi.encode(
                SELLORDER_TYPEHASH,
                order.maker,
                order.depositToken,
                order.unitPrice,
                order.unitDeposit,
                order.totalQuantity,
                order.minFillAmount,
                order.expiry,
                order.nonce,
                order.allowedBuyer,
                uint8(order.direction),
                order.agreementHash
            )
        );
        bytes32 digest = _hashTypedDataV4(structHash);
        
        // Verify signature
        address signer = ECDSA.recover(digest, signature);
        require(signer == order.maker, "Invalid maker signature");
        
        uint256 alreadyFilled = orderFilled[digest];
        return order.totalQuantity - alreadyFilled;
    }
}
