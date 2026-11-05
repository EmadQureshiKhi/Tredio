import Image from "next/image";
import { DATA_SOURCES, STACK } from "@/config/partners";

// Logos are sized to the same optical area, so a wide wordmark and a compact one carry equal weight.
const LOGO_AREA = 6400;

function Mark({ item }) {
  if (!item.logo) {
    return <span className="font-third text-[clamp(20px,1.7vw,30px)] leading-none tracking-[-0.01em] text-white">{item.name}</span>;
  }
  const { src, ratio, scale = 1, minWidth = 0 } = item.logo;
  const width = Math.max(minWidth, Math.round(Math.sqrt(LOGO_AREA * ratio) * scale));
  return (
    <Image
      src={src}
      alt={item.name}
      width={width}
      height={Math.round(width / ratio)}
      className="h-auto max-w-[82%] [width:calc(var(--logo-w)*var(--logo-scale))] min-w-[var(--logo-min)]"
      style={{ "--logo-w": `${width}px`, "--logo-min": minWidth ? `${minWidth}px` : "0px" }}
    />
  );
}

function Card({ item }) {
  const body = (
    <>
      <div className="flex flex-1 items-center justify-center px-4">
        <Mark item={item} />
      </div>
      <p className="px-4 pb-4 text-center font-body text-[12px] leading-[1.35] text-white/55 sm:text-[13px]">{item.role}</p>
    </>
  );
  const className =
    "flex min-h-[148px] flex-col rounded-2xl border border-white/[0.08] bg-white/[0.03] pt-5 transition-colors sm:min-h-[172px] lg:min-h-[clamp(172px,12vw,220px)]";
  if (!item.href) return <li className={className}>{body}</li>;
  return (
    <li className="flex">
      <a
        href={item.href}
        target="_blank"
        rel="noopener noreferrer"
        aria-label={`${item.name} (${item.role})`}
        className={`${className} w-full hover:border-[#9C93E8]/40 hover:bg-white/[0.05] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[#9C93E8]`}
      >
        {body}
      </a>
    </li>
  );
}

function Group({ title, items }) {
  return (
    <div className="mt-14 first-of-type:mt-0 lg:mt-[4.5vw]">
      <h3 className="mb-5 font-body text-[12px] font-semibold uppercase tracking-[0.18em] text-white/55">{title}</h3>
      <ul className="grid grid-cols-2 gap-3 [--logo-scale:0.8] sm:grid-cols-3 sm:gap-4 sm:[--logo-scale:0.9] lg:[--logo-scale:1]">
        {items.map((item) => (
          <Card key={item.name} item={item} />
        ))}
      </ul>
    </div>
  );
}

// "Built with": the network and services Tredio runs on, and the sources its attention index reads.
export default function Stack() {
  return (
    <section id="stack" aria-labelledby="stack-heading" className="relative z-[1] w-full bg-[#09090B] text-white">
      <div className="mx-auto w-full max-w-[1600px] px-6 py-24 sm:px-[6vw] lg:px-[4vw] lg:py-[8vw]">
        <div className="grid items-end gap-6 lg:grid-cols-[minmax(0,1.1fr)_minmax(0,0.9fr)] lg:gap-[6vw]">
          <div>
            <p className="font-body text-[12px] font-semibold uppercase tracking-[0.18em] text-[#C9C3F5]">Built with</p>
            <h2 id="stack-heading" className="mt-5 text-balance font-third text-[clamp(38px,4.6vw,84px)] leading-[1.02] tracking-[-0.02em]">
              Built on NEAR. Fed by the open web.
            </h2>
          </div>
          <p className="max-w-[560px] text-pretty font-body text-[clamp(16px,1.15vw,19px)] leading-[1.6] text-white/70">
            Tredio runs on these networks and services, and its attention index reads these sources. Names and logos belong to
            their owners, and showing them here does not mean they endorse Tredio.
          </p>
        </div>

        <div className="mt-14 lg:mt-[5vw]">
          <Group title="Runs on" items={STACK} />
          <Group title="Attention data" items={DATA_SOURCES} />
        </div>
      </div>
    </section>
  );
}
