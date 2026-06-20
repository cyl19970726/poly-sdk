import { describe, expect, it } from 'vitest';
import { ethers } from 'ethers';
import {
  COLLATERAL_CONTRACT,
  CTFClient,
  PUSD_CONTRACT,
  USDC_CONTRACT,
  USDC_E_CONTRACT,
  formatCollateralAmount,
  formatUsdc,
  parseCollateralAmount,
  parseUsdc,
} from '../../clients/ctf-client.js';
import { POLYGON_CONTRACTS_V2 } from '../../constants/v2-contracts.js';

describe('CTF V2 collateral routing', () => {
  it('uses pUSD as the CTF collateral and keeps USDC.e as a separate rail', () => {
    expect(PUSD_CONTRACT).toBe(POLYGON_CONTRACTS_V2.pUSD);
    expect(COLLATERAL_CONTRACT).toBe(POLYGON_CONTRACTS_V2.pUSD);
    expect(USDC_CONTRACT).toBe(POLYGON_CONTRACTS_V2.pUSD);
    expect(USDC_E_CONTRACT).toBe(POLYGON_CONTRACTS_V2.usdcE);
    expect(USDC_CONTRACT).not.toBe(USDC_E_CONTRACT);
  });

  it('keeps legacy amount helpers compatible with 6-decimal collateral amounts', () => {
    const parsed = parseCollateralAmount('12.345678');
    expect(parsed.toString()).toBe('12345678');
    expect(formatCollateralAmount(parsed)).toBe('12.345678');

    expect(parseUsdc('1.5').toString()).toBe(parseCollateralAmount('1.5').toString());
    expect(formatUsdc(parsed)).toBe(formatCollateralAmount(parsed));
  });

  it('manual position ID calculation uses pUSD collateral', () => {
    const client = new CTFClient({ rpcUrl: 'http://localhost:0' }) as unknown as {
      calculatePositionId(conditionId: string, indexSet: number): string;
    };
    const conditionId = `0x${'12'.repeat(32)}`;
    const indexSet = 1;

    const collectionId = ethers.utils.keccak256(
      ethers.utils.solidityPack(
        ['bytes32', 'bytes32', 'uint256'],
        [ethers.constants.HashZero, conditionId, indexSet]
      )
    );
    const expectedPositionId = ethers.utils.keccak256(
      ethers.utils.solidityPack(['address', 'bytes32'], [PUSD_CONTRACT, collectionId])
    );

    expect(client.calculatePositionId(conditionId, indexSet)).toBe(expectedPositionId);
  });
});
