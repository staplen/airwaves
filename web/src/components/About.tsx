import { useRef } from 'react';

/** Info button in the header that opens a short "what is this?" dialog. */
export function About() {
  const dialog = useRef<HTMLDialogElement>(null);
  return (
    <>
      <button type="button" className="strip-toggle" aria-label="About this dashboard" onClick={() => dialog.current?.showModal()}>
        <svg width="16" height="16" viewBox="0 0 16 16" aria-hidden="true">
          <circle cx="8" cy="8" r="6.5" fill="none" stroke="currentColor" strokeWidth="1.5" />
          <path d="M8 7.2v4" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
          <circle cx="8" cy="4.8" r="0.9" fill="currentColor" />
        </svg>
      </button>
      <dialog ref={dialog} className="about" aria-labelledby="about-title" onClick={(e) => e.target === dialog.current && dialog.current?.close()}>
        <div className="about-body">
          <h2 id="about-title">Airwaves</h2>
          <p>
            Everything one antenna and one inexpensive software-defined radio (an RTL-SDR dongle) can hear from a house near Washington, DC, decoded live from
            public radio signals.
          </p>
          <p className="about-offline">
            <b>None of this data comes from the internet.</b> Every aircraft, ship, message, sensor reading and audio clip is picked up over the air by the
            antenna and decoded on a Raspberry Pi in the house. There are no flight-tracking APIs or online feeds. Only the background map tiles and fonts load
            from the web.
          </p>
          <ul>
            <li><b>Aircraft</b> broadcasting their positions (ADS-B), airline datalink messages (VDL2/ACARS) and air traffic control audio.</li>
            <li><b>Ships</b> and channel markers on the Potomac (AIS).</li>
            <li><b>NOAA Weather Radio</b>, its alert codes, and twice-daily <b>weather balloons</b>.</li>
            <li>Around the house: <b>tire-pressure sensors</b> of passing cars, utility meters and other 315/433/915 MHz sensors.</li>
            <li><b>HD Radio</b> song info and a 24-hour <b>spectrum</b> sweep.</li>
          </ul>
          <p>
            One dongle can only listen to one slice of the spectrum at a time, so a scheduler rotates through decoders on a loop of about 20 minutes. The strip at
            the top shows what's tuned now and what's next, and each tile shows when its source was last heard.
          </p>
          <p className="muted">Audio is kept for 24 hours and everything else for 7 days. Only counts are shown for cars and meters, never their IDs.</p>
          <div className="about-actions">
            <a href="https://github.com/staplen/airwaves" target="_blank" rel="noreferrer">Source on GitHub</a>
            <button type="button" className="filt" onClick={() => dialog.current?.close()}>Close</button>
          </div>
        </div>
      </dialog>
    </>
  );
}
