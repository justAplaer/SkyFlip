import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { TimeMachinePanel } from "./TimeMachinePanel";
import { SpeedCard } from "./SpeedCard";
import type { MotionSpeedInfo, TimeTrackResponse } from "../types";

afterEach(() => { cleanup(); vi.restoreAllMocks(); });
const track: TimeTrackResponse = {name:"test",is_mover:true,start_year:2010,end_year:2035,n:2,catalog_ra:10,catalog_dec:20,ref_epoch:2010,proper_motion:{},points:[{date_iso:"2010-01-01",decimal_year:2010,mjd:55197,ra:10,dec:20},{date_iso:"2035-01-01",decimal_year:2035,mjd:64328,ra:11,dec:20}],key_dates:[],honesty:"prediction",method:"test",source:"pm_table"};
const speed: MotionSpeedInfo = {name:"WISE 0855",is_mover:true,pm_ra_cosdec_arcsec_yr:1,pm_dec_arcsec_yr:0,pm_total_arcsec_yr:1,pm_citation:"source",pm_uncertainty_note:"",tangential_velocity_kms:85.4,solar_speed_kms:null,radial_velocity_kms:null,familiar:{arcsec_per_year:1,arcsec_per_decade:10,moon_widths_per_year:0,years_per_moon_width:1800}};

describe("time playback and object speed", () => {
  it("allows explicit play with reduced motion and restarts at the end", () => {
    const onYearChange = vi.fn();
    render(<TimeMachinePanel track={track} year={2035} onYearChange={onYearChange} frameDecimalYear={null} reducedMotion={true} />);
    const play = screen.getByRole("button", {name:"Play through time"}) as HTMLButtonElement;
    expect(play.disabled).toBe(false);
    fireEvent.click(play);
    expect(onYearChange).toHaveBeenCalledWith(2010);
    expect(screen.getByRole("button", {name:"Pause time"})).toBeTruthy();
  });
  it("displays a labeled lower-bound speed when radial velocity is missing", () => {
    render(<SpeedCard speed={speed} />);
    expect(screen.getByTestId("speed-headline").textContent).toContain("85 km/s");
    expect(screen.getByText(/total speed is unknown/i)).toBeTruthy();
  });
});
