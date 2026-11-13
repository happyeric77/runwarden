// Shared by seed and synchronous tool validation.
// Amounts sit on both sides of USD 50. ord_07 is already fully refunded.
export const ORDERS = [
  ['ord_01', 'cus_01', 'placed', 25],
  ['ord_02', 'cus_02', 'placed', 49.5],
  ['ord_03', 'cus_03', 'placed', 50],
  ['ord_04', 'cus_02', 'shipped', 75],
  ['ord_05', 'cus_03', 'shipped', 120],
  ['ord_06', 'cus_04', 'placed', 15],
  ['ord_07', 'cus_04', 'refunded', 80],
  ['ord_08', 'cus_05', 'shipped', 200],
  ['ord_09', 'cus_05', 'cancelled', 30],
  ['ord_10', 'cus_06', 'placed', 500],
] as const;
