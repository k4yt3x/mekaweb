import { Slot } from '@radix-ui/react-slot';
import { cva, type VariantProps } from 'class-variance-authority';
import { clsx } from 'clsx';
import { twMerge } from 'tailwind-merge';
import type { ComponentProps } from 'react';
// Adapted from shadcn/ui's MIT-licensed button primitive.
const variants = cva('button', {
  variants: {
    variant: {
      default: 'button-primary',
      secondary: 'button-secondary',
      ghost: 'button-ghost',
      destructive: 'button-danger',
    },
    size: { default: '', sm: 'button-small', icon: 'button-icon' },
    /** `danger` keeps the variant's look but turns red on hover or focus, for destructive actions. */
    tone: { default: '', danger: 'button-caution' },
  },
  defaultVariants: { variant: 'default', size: 'default', tone: 'default' },
});
export function Button({
  className,
  variant,
  size,
  tone,
  asChild = false,
  type = 'button',
  ...props
}: ComponentProps<'button'> & VariantProps<typeof variants> & { asChild?: boolean }) {
  const Component = asChild ? Slot : 'button';
  return (
    <Component
      className={twMerge(clsx(variants({ variant, size, tone }), className))}
      type={type}
      {...props}
    />
  );
}
