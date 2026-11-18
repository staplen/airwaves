import type { Snapshot } from '../../../shared/types.ts';
import { FAMILY_COLOR } from '../bands.ts';
import { ago } from '../live.ts';
import { ClipPlayer } from './ClipPlayer.tsx';

/** HD Radio stations the sweep has heard lately, with what's playing and a short audio snippet. */
export function RadioNow({ snapshot }: { snapshot?: Snapshot }) {
  const radio = snapshot?.radio ?? [];
  if (!snapshot || radio.length === 0) return null;
  const now = snapshot.now;
  return (
    <section className="card radio-now" aria-label="On the radio now">
      <div className="lbl">On the radio now</div>
      <div className="radio-grid">
        {radio.map((r) => {
          const playing = r.title ? `${r.title}${r.artist ? ` — ${r.artist}` : ''}` : r.slogan ?? 'No song information';
          return (
            <article key={r.key} className="radio-tile">
              {r.art ?? r.logo ? <img className="radio-art" src={r.art ?? r.logo} alt="" loading="lazy" /> : <div className="radio-art ph" aria-hidden="true">{r.freq}</div>}
              <div className="radio-info">
                <div className="radio-name">{r.name ?? `${r.freq} FM`}</div>
                <div className="radio-sub">
                  HD{r.program + 1} · {r.freq} MHz
                </div>
                <div className="radio-song" title={playing}>{playing}</div>
                <div className="radio-foot">
                  <span>updated {ago(r.updatedAt, now)}</span>
                  {r.clip && <ClipPlayer src={r.clip} color={FAMILY_COLOR.bcast} label={`${r.name ?? r.freq} snippet`} compact />}
                </div>
              </div>
            </article>
          );
        })}
      </div>
    </section>
  );
}
