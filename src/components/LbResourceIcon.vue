<script setup>
import station from '../assets/lb-station.svg'
import sat from '../assets/coverage-satellite.svg'
import carrier from '../assets/lb-carrier.svg'

const icons = { station, sat, carrier }
defineProps({ kind: { type: String, required: true } })
</script>

<template>
  <img class="lb-resource-icon" :src="icons[kind]" alt="" draggable="false" />
</template>

<style scoped>
.lb-resource-icon {
  display: inline-block;
  width: clamp(14px, 1.35em, 19px);
  height: auto;
  aspect-ratio: 1;
  flex: none;
  margin-inline-end: 3px;
  vertical-align: -0.25em;
  pointer-events: none;
}
</style>
