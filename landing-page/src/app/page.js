"use client";

import { useEffect, useState } from "react";
import { useLenis } from "lenis/react";
import Hero from "@/components/home/Hero";
import About from "@/components/home/About";
import Navbar from "@/components/header/Navbar";
import Tracks from "@/components/home/Tracks";
import Examples from "@/components/home/Examples";
import Stack from "@/components/home/Stack";
import Numbers from "@/components/home/Numbers";
import Launch from "@/components/home/Launch";
import Footer from "@/components/footer/Footer";
import AboutMobile from "@/components/mobile/About";
import HowItWorksMobile from "@/components/mobile/HowItWorks";
import MobileTracks from "@/components/mobile/MobileTracks";
import MobileExamples from "@/components/mobile/MobileExamples";
import MobileNumbers from "@/components/mobile/MobileNumbers";
import MobileLaunch from "@/components/mobile/MobileLaunch";
import MobileFooter from "@/components/footer/MobileFooter";
import WaitlistSection from "@/components/waitlist/WaitlistSection";

export default function Home() {
  const [isMobile, setIsMobile] = useState(false);
  const lenis = useLenis();

  // Arriving from another page at a section ("/#tracks"): scroll there once the layout settles.
  useEffect(() => {
    const hash = window.location.hash;
    if (!lenis || !hash || !document.querySelector(hash)) return;
    const timer = setTimeout(() => lenis.scrollTo(hash, { duration: 1.2 }), 800);
    return () => clearTimeout(timer);
  }, [lenis]);

  useEffect(() => {
    const checkMobile = () => {
      setIsMobile(window.innerWidth <= 768);
    };

    checkMobile();
    window.addEventListener("resize", checkMobile);

    return () => window.removeEventListener("resize", checkMobile);
  }, []);

  return (
    <>
      <Navbar />
      <main>
        <Hero />
        {isMobile ? <AboutMobile /> : <About />}
        {isMobile && <HowItWorksMobile />}
        {isMobile ? <MobileTracks /> : <Tracks />}
        {isMobile ? <MobileExamples /> : <Examples />}
        <Stack />
        {isMobile ? <MobileNumbers /> : <Numbers />}
        {isMobile ? <MobileLaunch /> : <Launch />}
        <WaitlistSection />
      </main>
      {isMobile ? <MobileFooter /> : <Footer />}
    </>
  );
}
