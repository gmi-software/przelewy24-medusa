import { describe, it, expect } from "vitest";
import {
  getSmallestUnit,
  getAmountFromSmallestUnit,
} from "../get-smallest-unit";

describe("getSmallestUnit", () => {
  it("converts PLN to grosze", () => {
    expect(getSmallestUnit(10, "PLN")).toBe(1000);
  });

  it("handles case-insensitive currency codes", () => {
    expect(getSmallestUnit(10, "pln")).toBe(1000);
  });

  it("defaults to multiplier of 100 for unknown currencies", () => {
    expect(getSmallestUnit(5, "CZK")).toBe(500);
  });

  it("rounds to avoid floating point issues", () => {
    expect(getSmallestUnit(19.99, "PLN")).toBe(1999);
  });
});

describe("getAmountFromSmallestUnit", () => {
  it("converts grosze to PLN", () => {
    expect(getAmountFromSmallestUnit(1000, "PLN")).toBe(10);
  });

  it("is the inverse of getSmallestUnit", () => {
    const amount = 49.99;
    const smallest = getSmallestUnit(amount, "PLN");
    expect(getAmountFromSmallestUnit(smallest, "PLN")).toBe(amount);
  });
});
