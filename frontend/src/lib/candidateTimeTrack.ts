import type { MoverCandidate, TimeTrackResponse } from "../types";
import { dateToDecimalYear, onSkySeparationArcsec } from "./timeMachineMath";

/** Build a bounded interpolation of detected positions; never extrapolate a candidate. */
export function candidateTimeTrack(candidate: MoverCandidate): TimeTrackResponse | null {
  const detections = candidate.track
    .filter(p => Number.isFinite(p.mjd) && Number.isFinite(p.ra) && Number.isFinite(p.dec) && p.dec >= -90 && p.dec <= 90)
    .map(p => ({...p, date: new Date((p.mjd - 40587) * 86400000)}))
    .filter(p => Number.isFinite(p.date.getTime()))
    .sort((a,b) => a.mjd-b.mjd)
    .filter((p,i,all) => i === 0 || p.mjd !== all[i-1].mjd);
  if (detections.length < 2) return null;
  const first = detections[0];
  const points = detections.map(p => ({date_iso:p.date.toISOString().slice(0,10),decimal_year:dateToDecimalYear(p.date),mjd:p.mjd,ra:p.ra,dec:p.dec,offset_from_catalog_arcsec:onSkySeparationArcsec(first.ra,first.dec,p.ra,p.dec)}));
  if (points[0].decimal_year < 2010 || points[points.length-1].decimal_year > 2035) return null;
  return {target_id:null,name:candidate.id,is_mover:true,start_year:points[0].decimal_year,end_year:points[points.length-1].decimal_year,n:points.length,catalog_ra:first.ra,catalog_dec:first.dec,ref_epoch:points[0].decimal_year,proper_motion:{citation:'Observed detections; not a catalog prediction',uncertainty_note:'Candidate positions and identification are unverified.'},points,key_dates:[],honesty:`Detected candidate ${candidate.id}: positions interpolate between the retrieved detections only. This is not a discovery or a prediction.`,non_mover_message:null,method:'Linear interpolation of detected positions; no extrapolation',source:'candidate'};
}
