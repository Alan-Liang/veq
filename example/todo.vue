<template>
  <main>
    <p v-if="loading">Loading todos...</p>
    <p v-else-if="loadError">Error loading todos: {{ loadError }}</p>
    <template v-else>
      <p>Add a todo: <input v-model="newTodo"> <button @click="addTodo">add</button></p>
      <ul>
        <li v-for="todo in todos" :key="todo.localId"><button @click="removeTodo(todo)">Remove</button> {{ todo.content }}</li>
      </ul>
    </template>
  </main>
</template>

<script>
on: server
const todos = []

on: server, client
const counter = (function* (i = 0) { while (true) yield ++i })()
const validateTodo = todo => typeof todo === 'string' && todo.length > 0 && todo.startsWith('TODO: ')

on: client
const todoTemplate = 'TODO: '
export default {
  data () {
    return {
      loading: true,
      loadError: null,
      todos: null,
      newTodo: todoTemplate,
    }
  },
  methods: {
    async addTodo () {
      const newTodo = this.newTodo
      this.newTodo = todoTemplate
      if (!validateTodo(newTodo)) {
        alert('Todo items must begin with `TODO: `!')
        return
      }
      const todo = { id: null, localId: counter.next(), content: newTodo }
      this.todos.push(todo)

      try {
        on: server
        if (!validateTodo(newTodo)) throw new Error('Invalid Todo.')
        const id = counter.next()
        todos.push({ id, content: newTodo })

        on: client
        todo.id = id
        if (todo.removed) this.removeTodo(todo)
      } catch (e) {
        alert('Error adding todo: ' + e)
        this.todos.splice(this.todos.indexOf(todo), 1)
      }
    },
    async removeTodo (todo) {
      const id = todo.id
      const index = this.todos.indexOf(todo)
      this.todos.splice(index, 1)
      if (id === null) {
        todo.removed = true
        return
      }

      try {
        on: server
        const serverIndex = todos.findIndex(todo => todo.id === id)
        todos.splice(serverIndex, 1)
      } catch (e) {
        alert('Error removing todo: ' + e)
        this.todos.splice(index, 0, todo)
      }
    },
  },
  async mounted () {
    try {
      on: server
      const serverTodos = todos

      on: client
      this.loading = false
      for (const todo of serverTodos) todo.localId = counter.next()
      this.todos = serverTodos
    } catch (e) {
      this.loading = false
      this.loadError = e
    }
  },
}
</script>
