import { createApp } from 'vue'
import { createPinia } from 'pinia'
import RainApp from './rain/RainApp.vue'
import './styles/global.css'
import './stores/theme'

createApp(RainApp).use(createPinia()).mount('#app')
