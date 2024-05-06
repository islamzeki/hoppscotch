import {
  HoppCollection,
  HoppRESTAuth,
  HoppRESTHeaders,
  HoppRESTRequest,
  makeCollection,
} from "@hoppscotch/data"
import { Service } from "dioc"
import * as E from "fp-ts/Either"
import { isEqual, merge } from "lodash-es"
import path from "path"
import {
  Ref,
  computed,
  effectScope,
  markRaw,
  ref,
  shallowRef,
  watch,
} from "vue"

import PersonalWorkspaceSelector from "~/components/workspace/PersonalWorkspaceSelector.vue"
import { useStreamStatic } from "~/composables/stream"

import {
  addRESTCollection,
  addRESTFolder,
  appendRESTCollections,
  editRESTCollection,
  editRESTFolder,
  editRESTRequest,
  moveRESTFolder,
  moveRESTRequest,
  navigateToFolderWithIndexPath,
  removeRESTCollection,
  removeRESTFolder,
  removeRESTRequest,
  restCollectionStore,
  saveRESTRequestAs,
  updateRESTCollectionOrder,
  updateRESTRequestOrder,
} from "~/newstore/collections"
import { platform } from "~/platform"

import { Handle, WritableHandleRef } from "~/services/new-workspace/handle"
import { WorkspaceProvider } from "~/services/new-workspace/provider"
import {
  RESTCollectionChildrenView,
  RESTCollectionJSONView,
  RESTCollectionLevelAuthHeadersView,
  RESTCollectionViewItem,
  RESTSearchResultsView,
  RootRESTCollectionView,
} from "~/services/new-workspace/view"
import {
  Workspace,
  WorkspaceCollection,
  WorkspaceDecor,
  WorkspaceRequest,
} from "~/services/new-workspace/workspace"

import { getAffectedIndexes } from "~/helpers/collection/affectedIndex"
import {
  getFoldersByPath,
  resolveSaveContextOnCollectionReorder,
} from "~/helpers/collection/collection"
import {
  getRequestsByPath,
  resolveSaveContextOnRequestReorder,
} from "~/helpers/collection/request"
import { initializeDownloadFile } from "~/helpers/import-export/export"
import { HoppInheritedProperty } from "~/helpers/types/HoppInheritedProperties"
import IconUser from "~icons/lucide/user"
import { NewWorkspaceService } from ".."
import {
  isValidCollectionHandle,
  isValidRequestHandle,
  isValidWorkspaceHandle,
} from "../helpers"

export class PersonalWorkspaceProviderService
  extends Service
  implements WorkspaceProvider
{
  public static readonly ID = "PERSONAL_WORKSPACE_PROVIDER_SERVICE"

  public readonly providerID = "PERSONAL_WORKSPACE_PROVIDER"

  private workspaceService = this.bind(NewWorkspaceService)

  public workspaceDecor: Ref<WorkspaceDecor> = ref({
    headerCurrentIcon: IconUser,
    workspaceSelectorComponent: PersonalWorkspaceSelector,
    workspaceSelectorPriority: 100,
  })

  private restCollectionState: Ref<{ state: HoppCollection[] }>

  private issuedHandles: WritableHandleRef<
    WorkspaceCollection | WorkspaceRequest
  >[] = []

  public constructor() {
    super()

    this.restCollectionState = useStreamStatic(
      restCollectionStore.subject$,
      { state: [] },
      () => {
        /* noop */
      }
    )[0]

    this.workspaceService.registerWorkspaceProvider(this)
  }

  /**
   * Used to get the index of the request from the path
   * @param path The path of the request
   * @returns The index of the request
   */
  private pathToLastIndex(path: string) {
    const pathArr = path.split("/")
    return parseInt(pathArr[pathArr.length - 1])
  }

  public createRESTRootCollection(
    workspaceHandle: Handle<Workspace>,
    newCollection: Partial<Exclude<HoppCollection, "id">> & { name: string }
  ): Promise<E.Either<unknown, Handle<WorkspaceCollection>>> {
    if (!isValidWorkspaceHandle(workspaceHandle, this.providerID, "personal")) {
      return Promise.resolve(E.left("INVALID_WORKSPACE_HANDLE" as const))
    }

    const newCollectionName = newCollection.name
    const newCollectionID =
      this.restCollectionState.value.state.length.toString()

    const newRootCollection = makeCollection({
      folders: [],
      requests: [],
      headers: [],
      auth: {
        authType: "inherit",
        authActive: false,
      },
      ...newCollection,
    })
    addRESTCollection(newRootCollection)

    platform.analytics?.logEvent({
      type: "HOPP_CREATE_COLLECTION",
      platform: "rest",
      workspaceType: "personal",
      isRootCollection: true,
    })

    return Promise.resolve(
      E.right(
        computed(() => {
          if (
            !isValidWorkspaceHandle(
              workspaceHandle,
              this.providerID,
              "personal"
            )
          ) {
            return {
              type: "invalid" as const,
              reason: "WORKSPACE_INVALIDATED" as const,
            }
          }

          return {
            type: "ok",
            data: {
              providerID: this.providerID,
              workspaceID: workspaceHandle.value.data.workspaceID,
              collectionID: newCollectionID,
              name: newCollectionName,
            },
          }
        })
      )
    )
  }

  public createRESTChildCollection(
    parentCollectionHandle: Handle<WorkspaceCollection>,
    newChildCollection: Partial<HoppCollection> & { name: string }
  ): Promise<E.Either<unknown, Handle<WorkspaceCollection>>> {
    if (
      !isValidCollectionHandle(
        parentCollectionHandle,
        this.providerID,
        "personal"
      )
    ) {
      return Promise.resolve(E.left("INVALID_COLLECTION_HANDLE" as const))
    }

    const { collectionID, providerID, workspaceID } =
      parentCollectionHandle.value.data

    const newCollectionName = newChildCollection.name
    addRESTFolder(newCollectionName, collectionID)

    platform.analytics?.logEvent({
      type: "HOPP_CREATE_COLLECTION",
      workspaceType: "personal",
      isRootCollection: false,
      platform: "rest",
    })

    return Promise.resolve(
      E.right(
        computed(() => {
          if (
            !isValidCollectionHandle(
              parentCollectionHandle,
              this.providerID,
              "personal"
            )
          ) {
            return {
              type: "invalid" as const,
              reason: "COLLECTION_INVALIDATED" as const,
            }
          }

          return {
            type: "ok",
            data: {
              providerID,
              workspaceID,
              collectionID,
              name: newCollectionName,
            },
          }
        })
      )
    )
  }

  public updateRESTCollection(
    collectionHandle: Handle<WorkspaceCollection>,
    updatedCollection: Partial<HoppCollection>
  ): Promise<E.Either<unknown, void>> {
    if (
      !isValidCollectionHandle(collectionHandle, this.providerID, "personal")
    ) {
      return Promise.resolve(E.left("INVALID_COLLECTION_HANDLE" as const))
    }

    const { collectionID } = collectionHandle.value.data

    const collection = navigateToFolderWithIndexPath(
      this.restCollectionState.value.state,
      collectionID.split("/").map((id) => parseInt(id))
    )

    const newCollection = { ...collection, ...updatedCollection }

    const isRootCollection = collectionID.split("/").length === 1

    if (isRootCollection) {
      editRESTCollection(parseInt(collectionID), newCollection)
    } else {
      editRESTFolder(collectionID, newCollection)
    }

    return Promise.resolve(E.right(undefined))
  }

  public removeRESTCollection(
    collectionHandle: Handle<WorkspaceCollection>
  ): Promise<E.Either<unknown, void>> {
    if (
      !isValidCollectionHandle(collectionHandle, this.providerID, "personal")
    ) {
      return Promise.resolve(E.left("INVALID_COLLECTION_HANDLE" as const))
    }

    const { collectionID } = collectionHandle.value.data

    const isRootCollection = collectionID.split("/").length === 1
    const collectionIndex = parseInt(collectionID)

    if (isRootCollection) {
      const collectionToRemove = navigateToFolderWithIndexPath(
        restCollectionStore.value.state,
        [collectionIndex]
      )

      removeRESTCollection(
        collectionIndex,
        collectionToRemove ? collectionToRemove.id : undefined
      )
    } else {
      const folderToRemove = path
        ? navigateToFolderWithIndexPath(
            restCollectionStore.value.state,
            collectionID.split("/").map((id) => parseInt(id))
          )
        : undefined

      removeRESTFolder(
        collectionID,
        folderToRemove ? folderToRemove.id : undefined
      )
    }

    for (const [idx, handle] of this.issuedHandles.entries()) {
      if (handle.value.type === "invalid") continue

      if ("requestID" in handle.value.data) {
        if (handle.value.data.requestID.startsWith(collectionID)) {
          // @ts-expect-error - We're deleting the data to invalidate the handle
          delete this.issuedHandles[idx].value.data

          this.issuedHandles[idx].value.type = "invalid"

          // @ts-expect-error - Setting the handle invalidation reason
          this.issuedHandles[idx].value.reason = "REQUEST_INVALIDATED"
        }
      }
    }

    if (isRootCollection) {
      resolveSaveContextOnCollectionReorder({
        lastIndex: collectionIndex,
        newIndex: -1,
        folderPath: "", // root folder
        length: restCollectionStore.value.state.length,
      })
    } else {
      const parentCollectionID = collectionID.split("/").slice(0, -1).join("/") // remove last folder to get parent folder
      resolveSaveContextOnCollectionReorder({
        lastIndex: this.pathToLastIndex(collectionID),
        newIndex: -1,
        folderPath: parentCollectionID,
        length: getFoldersByPath(
          restCollectionStore.value.state,
          parentCollectionID
        ).length,
      })
    }

    return Promise.resolve(E.right(undefined))
  }

  public createRESTRequest(
    parentCollectionHandle: Handle<WorkspaceCollection>,
    newRequest: HoppRESTRequest
  ): Promise<E.Either<unknown, Handle<WorkspaceRequest>>> {
    if (
      !isValidCollectionHandle(
        parentCollectionHandle,
        this.providerID,
        "personal"
      )
    ) {
      return Promise.resolve(E.left("INVALID_COLLECTION_HANDLE" as const))
    }

    const { collectionID, providerID, workspaceID } =
      parentCollectionHandle.value.data

    const insertionIndex = saveRESTRequestAs(collectionID, newRequest)

    const requestID = `${collectionID}/${insertionIndex}`

    platform.analytics?.logEvent({
      type: "HOPP_SAVE_REQUEST",
      workspaceType: "personal",
      createdNow: true,
      platform: "rest",
    })

    const handleRefData = ref({
      type: "ok" as const,
      data: {
        providerID,
        workspaceID,
        collectionID,
        requestID,
        request: newRequest,
      },
    })

    const handle: Handle<WorkspaceRequest> = computed(() => {
      if (
        !isValidCollectionHandle(
          parentCollectionHandle,
          this.providerID,
          "personal"
        )
      ) {
        return {
          type: "invalid" as const,
          reason: "COLLECTION_INVALIDATED" as const,
        }
      }

      return handleRefData.value
    })

    const writableHandle = computed({
      get() {
        return handleRefData.value
      },
      set(newValue) {
        handleRefData.value = newValue
      },
    })

    const handleIsAlreadyIssued = this.issuedHandles.some((handle) => {
      if (handle.value.type === "invalid") {
        return false
      }

      if (!("requestID" in handle.value.data)) {
        return false
      }

      const { request, ...dataProps } = handle.value.data

      if (
        isEqual(dataProps, {
          providerID,
          workspaceID,
          collectionID,
          requestID,
        })
      ) {
        return true
      }
    })

    if (!handleIsAlreadyIssued) {
      this.issuedHandles.push(writableHandle)
    }

    return Promise.resolve(E.right(handle))
  }

  public removeRESTRequest(
    requestHandle: Handle<WorkspaceRequest>
  ): Promise<E.Either<unknown, void>> {
    if (!isValidRequestHandle(requestHandle, this.providerID, "personal")) {
      return Promise.resolve(E.left("INVALID_REQUEST_HANDLE" as const))
    }

    const { collectionID, requestID } = requestHandle.value.data
    const requestIndex = parseInt(requestID.split("/").slice(-1)[0])

    const requestToRemove = navigateToFolderWithIndexPath(
      restCollectionStore.value.state,
      collectionID.split("/").map((id) => parseInt(id))
    )?.requests[requestIndex]

    removeRESTRequest(collectionID, requestIndex, requestToRemove?.id)

    for (const [idx, handle] of this.issuedHandles.entries()) {
      if (handle.value.type === "invalid") continue

      if ("requestID" in handle.value.data) {
        if (handle.value.data.requestID === requestID) {
          // @ts-expect-error - We're deleting the data to invalidate the handle
          delete this.issuedHandles[idx].value.data

          this.issuedHandles[idx].value.type = "invalid"

          // @ts-expect-error - Setting the handle invalidation reason
          this.issuedHandles[idx].value.reason = "REQUEST_INVALIDATED"
        }
      }
    }

    // The same function is used to reorder requests since after removing, it's basically doing reorder
    resolveSaveContextOnRequestReorder({
      lastIndex: requestIndex,
      newIndex: -1,
      folderPath: collectionID,
      length: getRequestsByPath(restCollectionStore.value.state, collectionID)
        .length,
    })

    return Promise.resolve(E.right(undefined))
  }

  public updateRESTRequest(
    requestHandle: Handle<WorkspaceRequest>,
    updatedRequest: Partial<HoppRESTRequest>
  ): Promise<E.Either<unknown, void>> {
    if (!isValidRequestHandle(requestHandle, this.providerID, "personal")) {
      return Promise.resolve(E.left("INVALID_REQUEST_HANDLE" as const))
    }

    delete updatedRequest.id

    const { collectionID, requestID, request } = requestHandle.value.data

    const newRequest: HoppRESTRequest = merge(request, updatedRequest)
    const requestIndex = parseInt(requestID.split("/").slice(-1)[0])
    editRESTRequest(collectionID, requestIndex, newRequest)

    platform.analytics?.logEvent({
      type: "HOPP_SAVE_REQUEST",
      platform: "rest",
      createdNow: false,
      workspaceType: "personal",
    })

    for (const [idx, handle] of this.issuedHandles.entries()) {
      if (handle.value.type === "invalid") continue

      if ("requestID" in handle.value.data) {
        if (handle.value.data.requestID === requestID) {
          // @ts-expect-error - We're updating the request data
          this.issuedHandles[idx].value.data.request.name = newRequest.name
        }
      }
    }

    return Promise.resolve(E.right(undefined))
  }

  public importRESTCollections(
    workspaceHandle: Handle<Workspace>,
    collections: HoppCollection[]
  ): Promise<E.Either<unknown, Handle<WorkspaceCollection>>> {
    if (!isValidWorkspaceHandle(workspaceHandle, this.providerID, "personal")) {
      return Promise.resolve(E.left("INVALID_WORKSPACE_HANDLE" as const))
    }

    appendRESTCollections(collections)

    const newCollectionName = collections[0].name
    const newCollectionID =
      this.restCollectionState.value.state.length.toString()

    return Promise.resolve(
      E.right(
        computed(() => {
          if (
            !isValidWorkspaceHandle(
              workspaceHandle,
              this.providerID,
              "personal"
            )
          ) {
            return {
              type: "invalid" as const,
              reason: "WORKSPACE_INVALIDATED" as const,
            }
          }

          return {
            type: "ok",
            data: {
              providerID: this.providerID,
              workspaceID: workspaceHandle.value.data.workspaceID,
              collectionID: newCollectionID,
              name: newCollectionName,
            },
          }
        })
      )
    )
  }

  public exportRESTCollections(
    workspaceHandle: Handle<WorkspaceCollection>,
    collections: HoppCollection[]
  ): Promise<E.Either<unknown, void>> {
    if (!isValidWorkspaceHandle(workspaceHandle, this.providerID, "personal")) {
      return Promise.resolve(E.left("INVALID_COLLECTION_HANDLE" as const))
    }

    initializeDownloadFile(JSON.stringify(collections, null, 2), "Collections")

    return Promise.resolve(E.right(undefined))
  }

  public exportRESTCollection(
    collectionHandle: Handle<WorkspaceCollection>,
    collection: HoppCollection
  ): Promise<E.Either<unknown, void>> {
    if (
      !isValidCollectionHandle(collectionHandle, this.providerID, "personal")
    ) {
      return Promise.resolve(E.left("INVALID_COLLECTION_HANDLE" as const))
    }

    initializeDownloadFile(JSON.stringify(collection, null, 2), collection.name)

    return Promise.resolve(E.right(undefined))
  }

  public reorderRESTCollection(
    collectionHandle: Handle<WorkspaceCollection>,
    destinationCollectionID: string | null
  ): Promise<E.Either<unknown, void>> {
    if (
      !isValidCollectionHandle(collectionHandle, this.providerID, "personal")
    ) {
      return Promise.resolve(E.left("INVALID_COLLECTION_HANDLE" as const))
    }

    const draggedCollectionIndex = collectionHandle.value.data.collectionID

    updateRESTCollectionOrder(draggedCollectionIndex, destinationCollectionID)

    return Promise.resolve(E.right(undefined))
  }

  public moveRESTCollection(
    collectionHandle: Handle<WorkspaceCollection>,
    destinationCollectionID: string | null
  ): Promise<E.Either<unknown, void>> {
    if (
      !isValidCollectionHandle(collectionHandle, this.providerID, "personal")
    ) {
      return Promise.resolve(E.left("INVALID_COLLECTION_HANDLE" as const))
    }

    moveRESTFolder(
      collectionHandle.value.data.collectionID,
      destinationCollectionID
    )

    return Promise.resolve(E.right(undefined))
  }

  public reorderRESTRequest(
    requestHandle: Handle<WorkspaceRequest>,
    destinationCollectionID: string,
    destinationRequestID: string | null
  ): Promise<E.Either<unknown, void>> {
    if (!isValidRequestHandle(requestHandle, this.providerID, "personal")) {
      return Promise.resolve(E.left("INVALID_REQUEST_HANDLE" as const))
    }

    const draggedRequestIndex = requestHandle.value.data.requestID

    updateRESTRequestOrder(
      this.pathToLastIndex(draggedRequestIndex),
      destinationRequestID ? this.pathToLastIndex(destinationRequestID) : null,
      destinationCollectionID
    )

    return Promise.resolve(E.right(undefined))
  }

  public moveRESTRequest(
    requestHandle: Handle<WorkspaceRequest>,
    destinationCollectionID: string
  ): Promise<E.Either<unknown, void>> {
    if (!isValidRequestHandle(requestHandle, this.providerID, "personal")) {
      return Promise.resolve(E.left("INVALID_REQUEST_HANDLE" as const))
    }

    const { requestID: draggedRequestID } = requestHandle.value.data
    const sourceCollectionID = draggedRequestID
      .split("/")
      .slice(0, -1)
      .join("/")

    const draggedRequestIndexPos = this.pathToLastIndex(draggedRequestID)

    const movedRequestHandleIdx = this.issuedHandles.findIndex((handle) => {
      if (handle.value.type === "invalid") {
        return
      }

      if (!("requestID" in handle.value.data)) {
        return
      }

      return handle.value.data.requestID === draggedRequestID
    })

    const movedRequestHandle = this.issuedHandles[movedRequestHandleIdx]

    if (
      !movedRequestHandle ||
      movedRequestHandle.value.type === "invalid" ||
      !("requestID" in movedRequestHandle.value.data)
    ) {
      return Promise.resolve(E.left("INVALID_REQUEST_HANDLE" as const))
    }

    const draggedCollectionReqCountBeforeMove = getRequestsByPath(
      restCollectionStore.value.state,
      sourceCollectionID
    ).length

    // Requests appearing below the request being moved will be affected by the action
    const affectedReqIndexRange =
      draggedCollectionReqCountBeforeMove - 1 - draggedRequestIndexPos

    const affectedRequestIDs = Array.from({
      length: affectedReqIndexRange,
    }).map((_, idx) => {
      const val = affectedReqIndexRange + idx
      return `${sourceCollectionID}/${val}`
    })

    moveRESTRequest(
      sourceCollectionID,
      draggedRequestIndexPos,
      destinationCollectionID
    )

    const destinationCollectionReqCount = getRequestsByPath(
      restCollectionStore.value.state,
      destinationCollectionID
    ).length

    // @ts-expect-error - Updating handle data the moved request
    this.issuedHandles[movedRequestHandleIdx].value.data = {
      // @ts-expect-error - Updating the IDs
      ...this.issuedHandles[movedRequestHandleIdx].value.data,
      collectionID: destinationCollectionID,
      requestID: `${destinationCollectionID}/${
        destinationCollectionReqCount - 1
      }`,
    }

    affectedRequestIDs.forEach((requestID) => {
      const handleIdx = this.issuedHandles.findIndex((handle) => {
        if (handle.value.type === "invalid") {
          return
        }

        if (!("requestID" in handle.value.data)) {
          return
        }

        return handle.value.data.requestID === requestID
      })

      const handle = this.issuedHandles[handleIdx]

      if (
        !handle ||
        handle.value.type === "invalid" ||
        !("requestID" in handle.value.data)
      ) {
        return
      }

      // Decrement the index pos in affected requests due to move
      const reqIndexPos = Number(
        handle.value.data.requestID.split("/").slice(-1)[0]
      )

      // @ts-expect-error - Updating the request ID
      this.issuedHandles[handleIdx].value.data = {
        ...handle.value.data,
        requestID: `${sourceCollectionID}/${reqIndexPos - 1}`,
      }
    })

    return Promise.resolve(E.right(undefined))
  }

  public getCollectionHandle(
    workspaceHandle: Handle<Workspace>,
    collectionID: string
  ): Promise<E.Either<unknown, Handle<WorkspaceCollection>>> {
    if (!isValidWorkspaceHandle(workspaceHandle, this.providerID, "personal")) {
      return Promise.resolve(E.left("INVALID_WORKSPACE_HANDLE" as const))
    }

    if (collectionID === "") {
      return Promise.resolve(E.left("INVALID_COLLECTION_ID" as const))
    }

    const collection = navigateToFolderWithIndexPath(
      this.restCollectionState.value.state,
      collectionID.split("/").map((x) => parseInt(x))
    )

    if (!collection) {
      return Promise.resolve(E.left("COLLECTION_NOT_FOUND"))
    }

    const { providerID, workspaceID } = workspaceHandle.value.data

    return Promise.resolve(
      E.right(
        computed(() => {
          if (
            !isValidWorkspaceHandle(
              workspaceHandle,
              this.providerID,
              "personal"
            )
          ) {
            return {
              type: "invalid" as const,
              reason: "WORKSPACE_INVALIDATED" as const,
            }
          }

          return {
            type: "ok",
            data: {
              providerID,
              workspaceID,
              collectionID,
              name: collection.name,
            },
          }
        })
      )
    )
  }

  public getRequestHandle(
    workspaceHandle: Handle<Workspace>,
    requestID: string
  ): Promise<E.Either<unknown, Handle<WorkspaceRequest>>> {
    if (!isValidWorkspaceHandle(workspaceHandle, this.providerID, "personal")) {
      return Promise.resolve(E.left("INVALID_COLLECTION_HANDLE" as const))
    }

    if (requestID === "") {
      return Promise.resolve(E.left("INVALID_REQUEST_ID" as const))
    }

    const { providerID, workspaceID } = workspaceHandle.value.data

    const collectionID = requestID.split("/").slice(0, -1).join("/")
    const requestIndexPath = requestID.split("/").slice(-1)[0]

    if (!requestIndexPath) {
      return Promise.resolve(E.left("INVALID_REQUEST_ID" as const))
    }

    const requestIndex = parseInt(requestIndexPath)

    // Navigate to the collection containing the request
    const collection = navigateToFolderWithIndexPath(
      this.restCollectionState.value.state,
      collectionID.split("/").map((x) => parseInt(x))
    )

    // Grab the request with it's index
    const request = collection?.requests[requestIndex] as
      | HoppRESTRequest
      | undefined

    if (!request) {
      return Promise.resolve(E.left("REQUEST_NOT_FOUND" as const))
    }

    const handleRefData = ref({
      type: "ok" as const,
      data: {
        providerID,
        workspaceID,
        collectionID,
        requestID,
        request,
      },
    })

    const handle: Handle<WorkspaceRequest> = computed(() => {
      if (
        !isValidWorkspaceHandle(workspaceHandle, this.providerID, "personal")
      ) {
        return {
          type: "invalid" as const,
          reason: "WORKSPACE_INVALIDATED" as const,
        }
      }

      return handleRefData.value
    })

    const writableHandle = computed({
      get() {
        return handleRefData.value
      },
      set(newValue) {
        handleRefData.value = newValue
      },
    })

    const handleIsAlreadyIssued = this.issuedHandles.some((handle) => {
      if (handle.value.type === "invalid") {
        return false
      }

      if (!("requestID" in handle.value.data)) {
        return false
      }

      const { request, ...dataProps } = handle.value.data

      if (
        isEqual(dataProps, {
          providerID,
          workspaceID,
          collectionID,
          requestID,
        })
      ) {
        return true
      }
    })

    if (!handleIsAlreadyIssued) {
      this.issuedHandles.push(writableHandle)
    }

    return Promise.resolve(E.right(handle))
  }

  public getRESTCollectionChildrenView(
    collectionHandle: Handle<WorkspaceCollection>
  ): Promise<E.Either<never, Handle<RESTCollectionChildrenView>>> {
    return Promise.resolve(
      E.right(
        computed(() => {
          if (
            !isValidCollectionHandle(
              collectionHandle,
              this.providerID,
              "personal"
            )
          ) {
            return {
              type: "invalid" as const,
              reason: "INVALID_COLLECTION_HANDLE" as const,
            }
          }

          const collectionID = collectionHandle.value.data.collectionID

          return markRaw({
            type: "ok" as const,
            data: {
              providerID: this.providerID,
              workspaceID: collectionHandle.value.data.workspaceID,
              collectionID: collectionHandle.value.data.collectionID,

              loading: ref(false),

              content: computed(() => {
                const indexPath = collectionID
                  .split("/")
                  .map((x) => parseInt(x))

                const item = navigateToFolderWithIndexPath(
                  this.restCollectionState.value.state,
                  indexPath
                )

                if (item) {
                  const collections = item.folders.map((childColl, id) => {
                    return <RESTCollectionViewItem>{
                      type: "collection",
                      value: {
                        collectionID: `${collectionID}/${id}`,
                        isLastItem:
                          item.folders?.length > 1
                            ? id === item.folders.length - 1
                            : false,
                        name: childColl.name,
                        parentCollectionID: collectionID,
                      },
                    }
                  })

                  const requests = item.requests.map((req, id) => {
                    // TODO: Replace `parentCollectionID` with `collectionID`
                    return <RESTCollectionViewItem>{
                      type: "request",
                      value: {
                        isLastItem:
                          item.requests?.length > 1
                            ? id === item.requests.length - 1
                            : false,
                        collectionID,
                        requestID: `${collectionID}/${id}`,
                        request: req,
                      },
                    }
                  })

                  return [...collections, ...requests]
                }
                return []
              }),
            },
          })
        })
      )
    )
  }

  public getRESTRootCollectionView(
    workspaceHandle: Handle<Workspace>
  ): Promise<E.Either<never, Handle<RootRESTCollectionView>>> {
    return Promise.resolve(
      E.right(
        computed(() => {
          if (
            !isValidWorkspaceHandle(
              workspaceHandle,
              this.providerID,
              "personal"
            )
          ) {
            return {
              type: "invalid" as const,
              reason: "INVALID_WORKSPACE_HANDLE" as const,
            }
          }

          return markRaw({
            type: "ok" as const,
            data: {
              providerID: this.providerID,
              workspaceID: workspaceHandle.value.data.workspaceID,

              loading: ref(false),

              collections: computed(() => {
                return this.restCollectionState.value.state.map((coll, id) => {
                  return {
                    collectionID: id.toString(),
                    isLastItem:
                      id === this.restCollectionState.value.state.length - 1,
                    name: coll.name,
                    parentCollectionID: null,
                  }
                })
              }),
            },
          })
        })
      )
    )
  }

  public getRESTCollectionLevelAuthHeadersView(
    collectionHandle: Handle<WorkspaceCollection>
  ): Promise<E.Either<never, Handle<RESTCollectionLevelAuthHeadersView>>> {
    return Promise.resolve(
      E.right(
        computed(() => {
          if (
            !isValidCollectionHandle(
              collectionHandle,
              this.providerID,
              "personal"
            )
          ) {
            return {
              type: "invalid" as const,
              reason: "INVALID_COLLECTION_HANDLE" as const,
            }
          }

          const { collectionID } = collectionHandle.value.data

          let auth: HoppInheritedProperty["auth"] = {
            parentID: collectionID ?? "",
            parentName: "",
            inheritedAuth: {
              authType: "none",
              authActive: true,
            },
          }
          const headers: HoppInheritedProperty["headers"] = []

          if (!collectionID) return { type: "ok", data: { auth, headers } }

          const path = collectionID.split("/").map((i) => parseInt(i))

          // Check if the path is empty or invalid
          if (!path || path.length === 0) {
            console.error("Invalid path:", collectionID)
            return { type: "ok", data: { auth, headers } }
          }

          // Loop through the path and get the last parent folder with authType other than 'inherit'
          for (let i = 0; i < path.length; i++) {
            const parentFolder = navigateToFolderWithIndexPath(
              this.restCollectionState.value.state,
              [...path.slice(0, i + 1)] // Create a copy of the path array
            )

            // Check if parentFolder is undefined or null
            if (!parentFolder) {
              console.error("Parent folder not found for path:", path)
              return { type: "ok", data: { auth, headers } }
            }

            const parentFolderAuth: HoppRESTAuth = parentFolder.auth
            const parentFolderHeaders: HoppRESTHeaders = parentFolder.headers

            // check if the parent folder has authType 'inherit' and if it is the root folder
            if (
              parentFolderAuth?.authType === "inherit" &&
              [...path.slice(0, i + 1)].length === 1
            ) {
              auth = {
                parentID: [...path.slice(0, i + 1)].join("/"),
                parentName: parentFolder.name,
                inheritedAuth: auth.inheritedAuth,
              }
            }

            if (parentFolderAuth?.authType !== "inherit") {
              auth = {
                parentID: [...path.slice(0, i + 1)].join("/"),
                parentName: parentFolder.name,
                inheritedAuth: parentFolderAuth,
              }
            }

            // Update headers, overwriting duplicates by key
            if (parentFolderHeaders) {
              const activeHeaders = parentFolderHeaders.filter((h) => h.active)
              activeHeaders.forEach((header) => {
                const index = headers.findIndex(
                  (h) => h.inheritedHeader?.key === header.key
                )
                const currentPath = [...path.slice(0, i + 1)].join("/")
                if (index !== -1) {
                  // Replace the existing header with the same key
                  headers[index] = {
                    parentID: currentPath,
                    parentName: parentFolder.name,
                    inheritedHeader: header,
                  }
                } else {
                  headers.push({
                    parentID: currentPath,
                    parentName: parentFolder.name,
                    inheritedHeader: header,
                  })
                }
              })
            }
          }

          return { type: "ok", data: { auth, headers } }
        })
      )
    )
  }

  public getRESTSearchResultsView(
    workspaceHandle: Handle<Workspace>,
    searchQuery: Ref<string>
  ): Promise<E.Either<never, Handle<RESTSearchResultsView>>> {
    const results = ref<HoppCollection[]>([])

    const isMatch = (inputText: string, textToMatch: string) =>
      inputText.toLowerCase().includes(textToMatch.toLowerCase())

    const filterRequests = (requests: HoppRESTRequest[]) => {
      return requests.filter((request) =>
        isMatch(request.name, searchQuery.value)
      )
    }

    const filterChildCollections = (
      childCollections: HoppCollection[]
    ): HoppCollection[] => {
      return childCollections
        .map((childCollection) => {
          // Render the entire collection tree if the search query matches a collection name
          if (isMatch(childCollection.name, searchQuery.value)) {
            return childCollection
          }

          const requests = filterRequests(
            childCollection.requests as HoppRESTRequest[]
          )
          const folders = filterChildCollections(childCollection.folders)

          return {
            ...childCollection,
            requests,
            folders,
          }
        })
        .filter(
          (childCollection) =>
            childCollection.requests.length > 0 ||
            childCollection.folders.length > 0 ||
            isMatch(childCollection.name, searchQuery.value)
        )
    }

    const scopeHandle = effectScope()

    scopeHandle.run(() => {
      watch(
        searchQuery,
        (newSearchQuery) => {
          if (!newSearchQuery) {
            results.value = this.restCollectionState.value.state
            return
          }

          const filteredCollections = this.restCollectionState.value.state
            .map((collection) => {
              // Render the entire collection tree if the search query matches a collection name
              if (isMatch(collection.name, searchQuery.value)) {
                return collection
              }

              const requests = filterRequests(
                collection.requests as HoppRESTRequest[]
              )
              const folders = filterChildCollections(collection.folders)

              return {
                ...collection,
                requests,
                folders,
              }
            })
            .filter(
              (collection) =>
                collection.requests.length > 0 ||
                collection.folders.length > 0 ||
                isMatch(collection.name, searchQuery.value)
            )

          results.value = filteredCollections
        },
        { immediate: true }
      )
    })

    const onSessionEnd = () => {
      scopeHandle.stop()
    }

    return Promise.resolve(
      E.right(
        computed(() => {
          if (
            !isValidWorkspaceHandle(
              workspaceHandle,
              this.providerID,
              "personal"
            )
          ) {
            return {
              type: "invalid" as const,
              reason: "INVALID_WORKSPACE_HANDLE" as const,
            }
          }

          return markRaw({
            type: "ok" as const,
            data: {
              providerID: this.providerID,
              workspaceID: workspaceHandle.value.data.workspaceID,

              loading: ref(false),

              results,
              onSessionEnd,
            },
          })
        })
      )
    )
  }

  public getRESTCollectionJSONView(
    workspaceHandle: Handle<Workspace>
  ): Promise<E.Either<never, Handle<RESTCollectionJSONView>>> {
    return Promise.resolve(
      E.right(
        computed(() => {
          if (
            !isValidWorkspaceHandle(
              workspaceHandle,
              this.providerID,
              "personal"
            )
          ) {
            return {
              type: "invalid" as const,
              reason: "INVALID_WORKSPACE_HANDLE" as const,
            }
          }

          return markRaw({
            type: "ok" as const,
            data: {
              providerID: this.providerID,
              workspaceID: workspaceHandle.value.data.workspaceID,
              content: JSON.stringify(
                this.restCollectionState.value.state,
                null,
                2
              ),
            },
          })
        })
      )
    )
  }

  public getWorkspaceHandle(
    workspaceID: string
  ): Promise<E.Either<unknown, Handle<Workspace>>> {
    if (workspaceID !== "personal") {
      return Promise.resolve(E.left("INVALID_WORKSPACE_ID" as const))
    }

    return Promise.resolve(E.right(this.getPersonalWorkspaceHandle()))
  }

  public getPersonalWorkspaceHandle(): Handle<Workspace> {
    return shallowRef({
      type: "ok" as const,
      data: {
        providerID: this.providerID,
        workspaceID: "personal",

        name: "Personal Workspace",
      },
    })
  }
}
