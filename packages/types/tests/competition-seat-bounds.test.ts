import { CompetitionEntrantSchema } from "../src/canonical/competition";

describe("competition table-seat bounds", () => {
  const entrant = {
    principalId: "service-seat-bounds",
    kind: "SERVICE",
    entryState: "NOT_REQUIRED",
  };

  test.each([0, 9])("accepts table seat %i", (seat) => {
    expect(CompetitionEntrantSchema.safeParse({ ...entrant, seat }).success).toBe(true);
  });

  test.each([-1, 10, 99, 0.5])("rejects invalid table seat %s", (seat) => {
    expect(CompetitionEntrantSchema.safeParse({ ...entrant, seat }).success).toBe(false);
  });
});
