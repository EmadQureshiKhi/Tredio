import Link from 'next/link'
import React from 'react'

const MobileBtn = ({bgColor='bg-white', text='hello', href='/', newTab = false}) => {
  return (
    <Link href={href} {...(newTab ? { target: '_blank', rel: 'noopener noreferrer' } : {})} className={`w-fit rounded-md overflow-hidden`}>
      
            <p className={`${bgColor} w-fit px-4 py-2 rounded-md font-semibold`}>
                {text}
            </p>
       
    </Link>
  )
}

export default MobileBtn