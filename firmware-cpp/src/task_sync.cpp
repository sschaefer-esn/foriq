#include "task_sync.h"

static SemaphoreHandle_t _bufferMutex = nullptr;
static TaskHandle_t _networkTaskHandle = nullptr;

volatile bool TaskSync::sleepRequested = false;
volatile bool TaskSync::wakeRequested = false;
volatile bool TaskSync::networkBusy = false;

void TaskSync::init() {
    _bufferMutex = xSemaphoreCreateMutex();
}

SemaphoreHandle_t TaskSync::getBufferMutex() {
    return _bufferMutex;
}

void TaskSync::setNetworkTaskHandle(TaskHandle_t handle) {
    _networkTaskHandle = handle;
}

void TaskSync::notifyNetworkTask() {
    if (_networkTaskHandle) {
        xTaskNotifyGive(_networkTaskHandle);
    }
}
