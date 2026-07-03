import { createApp } from 'vue'
import { createPinia } from 'pinia'
import LinkBudgetApp from './linkbudget/LinkBudgetApp.vue'
import './styles/global.css'
import './stores/theme'

createApp(LinkBudgetApp).use(createPinia()).mount('#app')
