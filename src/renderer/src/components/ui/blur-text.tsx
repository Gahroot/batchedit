import { motion } from 'framer-motion'
import { cn } from '@/lib/utils'

interface BlurTextProps {
  text: string
  className?: string
  delay?: number
  stagger?: number
}

export function BlurText({ text, className, delay = 0, stagger = 0.05 }: BlurTextProps) {
  const words = text.split(' ')
  return (
    <span className={cn('inline-block', className)}>
      {words.map((word, i) => (
        <motion.span
          key={`${word}-${i}`}
          initial={{ filter: 'blur(8px)', opacity: 0, y: 6 }}
          animate={{ filter: 'blur(0px)', opacity: 1, y: 0 }}
          transition={{
            duration: 0.45,
            delay: delay + i * stagger,
            ease: 'easeOut'
          }}
          className="inline-block"
        >
          {word}
          {i < words.length - 1 ? '\u00A0' : ''}
        </motion.span>
      ))}
    </span>
  )
}
