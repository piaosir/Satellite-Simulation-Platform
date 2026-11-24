<script setup>
import satellite from '../assets/coverage-satellite.svg'
import antenna from '../assets/coverage-antenna.svg'

defineProps({
  kind: { type: String, required: true, validator: value => ['satellite', 'antenna'].includes(value) },
  visible: { type: Boolean, required: true }
})
</script>

<template>
  <img v-if="kind === 'satellite'" class="coverage-icon" :class="{ hidden: !visible }"
       :src="satellite" alt="" draggable="false" />
  <span v-else class="coverage-icon antenna" :class="{ hidden: !visible }" aria-hidden="true">
    <img :src="antenna" alt="" draggable="false" />
    <svg v-if="visible" viewBox="0 0 32 32" fill="none" stroke-linecap="round">
      <path d="M21.4 13.2a9.4 9.4 0 0 1-9 9" stroke="#759ac3" stroke-width="2.5"/>
      <path d="M28.9 14.1a16.8 16.8 0 0 1-15.6 15.2" stroke="#4d73a3" stroke-width="3"/>
    </svg>
  </span>
</template>

<style scoped>
.coverage-icon { display: block; flex: none; width: 24px; height: 24px; }
.antenna { display: grid; width: 21px; height: 21px; }
.antenna > * { grid-area: 1 / 1; width: 100%; height: 100%; }
.hidden { filter: grayscale(1); opacity: .62; }
</style>
