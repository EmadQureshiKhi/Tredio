import React from "react";

// The phone layout's take on the masked headline: the same four lines, set plainly.
const About = () => {
  return (
    <section id="about" className="h-screen w-full flex flex-col px-8 bg-[#9C93E8] justify-center items-center text-center">
      <p className="font-bold leading-[1.05] tracking-[-0.01em] text-[clamp(32px,9vw,60px)] text-[#09090B]">
        Trade what the internet watches.
        <br />
        Scored 0&nbsp;to&nbsp;100.
        <br />
        Verified on NEAR.
        <br />
        Settled in USDC.
      </p>
    </section>
  );
};

export default About;
