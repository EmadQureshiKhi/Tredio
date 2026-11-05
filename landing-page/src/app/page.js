"use client";

import { useEffect, useState } from "react";
import { useLenis } from "lenis/react";
import Hero from "@/components/home/Hero";
import About from "@/components/home/About";
import Navbar from "@/components/header/Navbar";
import Categories from "@/components/home/Categories";
import QuoteContact from "@/components/home/QuoteContact";
import Footer from "@/components/footer/Footer";
import Stats from "@/components/home/Stats";
import CaseStudy2 from "@/components/home/CaseStudy2";
import AboutMobile from "@/components/mobile/About";
import HighlightedProjects from "@/components/mobile/HighlightedProjects";
import MobileCategories from "@/components/mobile/MobileCategories";
import CaseStudy from "@/components/mobile/CaseStudy";
import MobileStats from "@/components/mobile/MobileStats";
import MobileQuoteContact from "@/components/mobile/MobileQuoteContact";
import MobileFooter from "@/components/footer/MobileFooter";
import WaitlistSection from "@/components/waitlist/WaitlistSection";

export default function Home() {
  const [isMobile, setIsMobile] = useState(false);
  const lenis = useLenis();

  // Arriving from another page at a section ("/#markets"): scroll there once the layout settles.
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
        {isMobile ? <HighlightedProjects /> : ""}
        {isMobile ? <MobileCategories /> : <Categories />}
        {isMobile ? <CaseStudy /> : <CaseStudy2 />}
        {isMobile ? <MobileStats /> : <Stats />}
        {isMobile ? <MobileQuoteContact /> : <QuoteContact />}
        <WaitlistSection />
      </main>
      {isMobile ? <MobileFooter /> : <Footer />}
    </>
  );
}
