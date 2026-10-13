// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

/// @dev Local stand-ins for the read-only parts of Mezo Borrow (mezo-org/musd) that the web app uses:
///      TroveManager.getTroveStatus / getEntireDebtAndColl / MCR / CCR, PriceFeed.fetchPrice and
///      BorrowerOperations.borrowingRate / minNetDebt. Only used by the end-to-end test on a local chain.
contract MockTroveManager {
    uint256 public constant MCR = 1.1e18;
    uint256 public constant CCR = 1.5e18;

    struct Trove {
        uint8 status;
        uint256 coll;
        uint256 principal;
        uint256 interest;
    }

    mapping(address => Trove) internal troves;

    function setTrove(address borrower, uint256 coll, uint256 principal, uint256 interest) external {
        troves[borrower] = Trove(1, coll, principal, interest);
    }

    function getTroveStatus(address borrower) external view returns (uint8) {
        return troves[borrower].status;
    }

    function getEntireDebtAndColl(address borrower)
        external
        view
        returns (
            uint256 coll,
            uint256 principal,
            uint256 interest,
            uint256 pendingCollateral,
            uint256 pendingPrincipal,
            uint256 pendingInterest
        )
    {
        Trove memory t = troves[borrower];
        return (t.coll, t.principal, t.interest, 0, 0, 0);
    }
}

contract MockPriceFeed {
    uint256 public price;

    constructor(uint256 price_) {
        price = price_;
    }

    function setPrice(uint256 price_) external {
        price = price_;
    }

    function fetchPrice() external view returns (uint256) {
        return price;
    }
}

contract MockBorrowerOperations {
    uint256 public constant borrowingRate = 1e15; // 0.1%, as on Mezo testnet
    uint256 public constant minNetDebt = 1800e18;
}
