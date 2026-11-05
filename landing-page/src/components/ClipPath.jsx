'use client'
import React, { useEffect } from 'react'
import gsap from 'gsap'
import Image from 'next/image'

const ClipPath = ({ clipRef }) => {


  useEffect(() => {
    const ctx = gsap.context(() => {
      if(globalThis.innerWidth>760){
      gsap.set('.clip-container', {
        scale: 0,
        rotateZ: -180,
        y:'-4vw',
        x:'2vw',
      })
      const tl = gsap.timeline()
      tl.to('.clip-container', {
        scale: 1,
        duration: 1,
        delay:0.2,
        ease:'power3.in'
      })
      .to('.bottom-clip', {
        clipPath: 'polygon(50% 2.45%, 100% 38.41%, 100% 100%, 0% 100%, 0% 40.5%)',
        duration:0.7,
        ease:'power2.out',
      },'-=0.2')
      .to('.clip-container', {
        rotateZ: 0,
        duration:1.2,
        y:'2vw',
        x:'-2vw',
        ease:'power4.inOut'
      },'=-0.3')
    }
    else {

      gsap.set('.clip-container', {
        scale: 0,
        rotateZ: -180,
        y:'-30vw',
        x:'-2vw',
      })
      const tl = gsap.timeline()
      tl.to('.clip-container', {
        scale: 1,
        duration: 1,
        delay:0.2,
        ease:'power3.in'
      })
      .to('.bottom-clip', {
        clipPath: 'polygon(50% 2.45%, 100% 38.41%, 100% 100%, 0% 100%, 0% 40.5%)',
        duration:0.7,
        ease:'power2.out',
      },'-=0.2')
      .to('.clip-container', {
        rotateZ: 0,
        duration:1.2,
        y:'8vw',
        x:'-2vw',
        ease:'power4.inOut'
      },'=-0.3')

    }
    })
  
    return () => ctx.revert()
  }, [])

  return (
    <div className='h-screen  w-screen absolute inset-0'>
      <div
        ref={clipRef}
        className='w-full h-screen max-sm:scale-2 scale-0 origin-center clip-container '
      >
        <div
          style={{
            clipPath: 'polygon(25% 0, 75% 0, 51% 100%, 49% 100%)',
          }}
          className='absolute top-[-70vw] max-sm:top-[-20vw] max-sm:scale-[1.8] left-[35vw] w-[110vw] top-clip h-[110vw] rotate-[45deg] max-sm:rotate-[40deg] bg-[#9C93E8]'
        />
        <div
          style={{
            clipPath:
              'polygon(50% 2.45%, 80% 100%, 80% 100%, 20% 100%, 20% 100%)',
          }}
          className='absolute overflow-hidden max-sm:scale-[1.5] max-sm:top-85 max-sm:h-[150vw] max-sm:w-[150vw] max-sm:left-[-90vw] max-sm:scale-1.2 top-[2vw] bottom-clip left-[-37vw] rotate-45 w-[110vw] h-[110vw] bg-[#9C93E8] max-sm:rotate-[40deg]'
        />
       
      </div>


    </div>
  )
}

export default ClipPath
