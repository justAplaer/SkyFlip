import { describe, it, expect } from "vitest";
import { candidateTimeTrack } from "./candidateTimeTrack";
import { interpolateTrack } from "./timeMachineMath";
import type { MoverCandidate } from "../types";
const candidate: MoverCandidate = {id:"c1",classification:"candidate",reasons:[],is_synthetic:false,track:[{epoch_id:"later",mjd:60010,ra:10.1,dec:20},{epoch_id:"first",mjd:60000,ra:10,dec:20}]};
describe("candidate time travel", () => {
 it("sorts detections and interpolates only within their observed dates", () => {
   const t=candidateTimeTrack(candidate)!;
   expect(t.source).toBe("candidate");
   expect(t.points[0].mjd).toBe(60000);
   expect(t.points[1].mjd).toBe(60010);
   expect(interpolateTrack(t.points,(t.start_year+t.end_year)/2)?.ra).toBeCloseTo(10.05,5);
   expect(interpolateTrack(t.points,t.end_year+1)?.ra).toBeCloseTo(10.1);
 });
 it("rejects single, invalid and duplicate-date observations", () => {
   expect(candidateTimeTrack({...candidate,track:[candidate.track[0]]})).toBeNull();
   expect(candidateTimeTrack({...candidate,track:[candidate.track[0],{...candidate.track[0]}]})).toBeNull();
   expect(candidateTimeTrack({...candidate,track:[candidate.track[0],{...candidate.track[1],ra:NaN}]})).toBeNull();
 });
});
