import { useRef } from 'react';

/** Info button in the header that opens a short "what is this?" dialog. */
export function About() {
  const dialog = useRef<HTMLDialogElement>(null);
  const title = useRef<HTMLHeadingElement>(null);
  // showModal() focuses the first link (GitHub, at the bottom) and scrolls to it; start at the top on the title instead.
  const open = () => {
    const d = dialog.current;
    if (!d) return;
    d.showModal();
    title.current?.focus({ preventScroll: true });
    d.scrollTop = 0;
  };
  return (
    <>
      <button type="button" className="strip-toggle" aria-label="About this dashboard" onClick={open}>
        <svg width="16" height="16" viewBox="0 0 16 16" aria-hidden="true">
          <circle cx="8" cy="8" r="6.5" fill="none" stroke="currentColor" strokeWidth="1.5" />
          <path d="M8 7.2v4" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
          <circle cx="8" cy="4.8" r="0.9" fill="currentColor" />
        </svg>
      </button>
      <dialog ref={dialog} className="about" aria-labelledby="about-title" onClick={(e) => e.target === dialog.current && dialog.current?.close()}>
        <div className="about-body">
          <h2 id="about-title" ref={title} tabIndex={-1}>Airwaves</h2>
          <p>
            Everything one antenna and one inexpensive software-defined radio (an RTL-SDR dongle) can hear from a house near Washington, DC, decoded live from
            public radio signals.
          </p>
          <p className="about-offline">
            <b>None of this data comes from the internet.</b> Every aircraft, ship, message, sensor reading and audio clip is picked up over the air by the
            antenna and decoded on a Raspberry Pi in the house. There are no flight-tracking APIs or online feeds. Only the background map tiles, fonts and a page-view counter load
            from the web.
          </p>
          <ul>
            <li><b>Air:</b> aircraft broadcasting their positions (ADS-B), airline datalink messages (VDL2 and ACARS) and air traffic control audio.</li>
            <li><b>Sea:</b> ships and channel markers on the Potomac (AIS).</li>
            <li><b>Weather:</b> NOAA Weather Radio clips and alert codes, and twice-daily weather balloons.</li>
            <li><b>Rail:</b> railroad radio and the end-of-train devices on passing freight.</li>
            <li><b>Amateur:</b> ham radio operators' positions, messages and weather stations (APRS).</li>
            <li><b>Broadcast:</b> HD Radio song info and clips, plus live traffic and weather radar sent as data alongside the stations.</li>
            <li><b>Home:</b> tire-pressure sensors of passing cars and nearby weather sensors. Only counts are shown, never IDs.</li>
          </ul>
          <p>
            One dongle can only listen to one slice of the spectrum at a time, so a scheduler rotates through the decoders on a loop of several minutes. The footer
            shows what's tuned now and how long it has left; the other bands show their last 24 hours of activity and filter the feed when tapped.
          </p>
          <div className="about-actions">
            <a href="https://github.com/staplen/airwaves" target="_blank" rel="noreferrer">Source on GitHub</a>
            <button type="button" className="filt" onClick={() => dialog.current?.close()}>Close</button>
          </div>
        </div>
      </dialog>
    </>
  );
}
