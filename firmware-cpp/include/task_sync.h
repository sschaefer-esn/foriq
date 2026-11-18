#pragma once
#include <freertos/FreeRTOS.h>
#include <freertos/semphr.h>
#include <freertos/task.h>

namespace TaskSync {
    void init();
    SemaphoreHandle_t getBufferMutex();
    void setNetworkTaskHandle(TaskHandle_t handle);
    void notifyNetworkTask();

    extern volatile bool sleepRequested;
    extern volatile bool wakeRequested;
    extern volatile bool networkBusy;
}
