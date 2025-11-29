import { evaluateBoard, rankBoard, HandRank, rankDescription } from "../src/index";

describe("Evaluator Correctness", () => {
  // Helper for clear test output
  const check = (board: string, expected: HandRank) => {
    const rank = rankBoard(board);
    expect(rank).toBe(expected);
    // Ensure description exists
    expect(rankDescription(rank)).toBeDefined();
  };

  // Test evaluateBoard explicitly to satisfy the compiler
  test("evaluateBoard", () => {
    const score = evaluateBoard("Ah Kh Qh Jh Th");
    expect(score).toBeLessThan(100); // Royal flush has very low score
  });

  // Test rankBoard
  test("rankBoard", () => {
    const rank = rankBoard("Ah Kh Qh Jh Th");
    expect(rank).toBe(HandRank.StraightFlush);
    expect(rankDescription(rank)).toBe("Straight Flush");
  });

  test("5 Card Hands", () => {
    check("Th Jh Qh Kh Ah", HandRank.StraightFlush);
    check("Th Jh Qh Kh 9h", HandRank.StraightFlush);
    check("Th Jh Js Jd Jc", HandRank.FourOfAKind);
    check("Th Jh Js Jd Tc", HandRank.FullHouse);
    check("8h Jh Qh Kh 9h", HandRank.Flush);
    check("Th Jh Qh Kh As", HandRank.Straight);
    check("As 2h 3d 4h 5c", HandRank.Straight);
    check("Th Jh Js Jd 9c", HandRank.ThreeOfAKind);
    check("Th Jh Js 9d 9c", HandRank.TwoPair);
    check("Th Jh 2s 9d 9c", HandRank.OnePair);
    check("Th Jh 2s Ad 9c", HandRank.HighCard);
  });

  test("6 Card Hands", () => {
    check("Th 3d Jh Qh Kh Ah", HandRank.StraightFlush);
    check("Th 3d Jh Qh Kh 9h", HandRank.StraightFlush);
    check("Th 3d Jh Js Jd Jc", HandRank.FourOfAKind);
    check("Th 3d Jh Js Jd Tc", HandRank.FullHouse);
    check("8h 3d Jh Qh Kh 9h", HandRank.Flush);
    check("Th 3d Jh Qh Kh As", HandRank.Straight);
    check("As 3d 2h 3d 4h 5c", HandRank.Straight);
    check("Th 3d Jh Js Jd 9c", HandRank.ThreeOfAKind);
    check("Th 3d Jh Js 9d 9c", HandRank.TwoPair);
    check("Th 3d Jh 2s 9d 9c", HandRank.OnePair);
    check("Th 3d Jh 2s Ad 9c", HandRank.HighCard);
  });

  test("7 Card Hands", () => {
    check("5c Th 3d Jh Qh Kh Ah", HandRank.StraightFlush);
    check("5c Th 3d Jh Qh Kh 9h", HandRank.StraightFlush);
    check("5c Th 3d Jh Js Jd Jc", HandRank.FourOfAKind);
    check("5c Th 3d Jh Js Jd Tc", HandRank.FullHouse);
    check("5c 8h 3d Jh Qh Kh 9h", HandRank.Flush);
    check("5c Th 3d Jh Qh Kh As", HandRank.Straight);
    check("5c As 3d 2h 3d 4h 5c", HandRank.Straight);
    check("5c Th 3d Jh Js Jd 9c", HandRank.ThreeOfAKind);
    check("5c Th 3d Jh Js 9d 9c", HandRank.TwoPair);
    check("5c Th 3d Jh 2s 9d 9c", HandRank.OnePair);
    check("5c Th 3d Jh 2s Ad 9c", HandRank.HighCard);
  });
});
